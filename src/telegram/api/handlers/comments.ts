import { z } from "zod";
import { HttpError } from "../../../api/errors.ts";
import { type PageQuery, type PageResult, toPage } from "../../../api/pagination.ts";
import type { Deps } from "../../../deps.ts";
import { isTelegramError } from "../../client/errors.ts";
import type { Sent } from "../../client/types.ts";
import {
  type CommentItem,
  type CommentRow,
  getComment,
  insertReply,
  listReplies,
  listTopLevel,
  markDeleted,
  refreshFromMessage,
  withHasReplies,
} from "../../models/comments.ts";
import { getPost, type PostRow, threadCoordinates } from "../../models/posts.ts";
import { translateReplyError } from "../errors.ts";

export const replyBodySchema = z.object({ text: z.string() });

const MAX_TEXT = 4096;
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

export function validateReplyText(text: string): void {
  if (text.trim() === "") {
    throw new HttpError(400, "malformed_message", "reply text can not be empty");
  }
  const codepoints = Array.from(text);
  if (codepoints.length > MAX_TEXT) {
    throw new HttpError(400, "malformed_message", "reply text is too long");
  }
  codepoints.forEach((ch, position) => {
    const cp = ch.codePointAt(0) ?? 0;
    const control = (cp < 0x20 && !ALLOWED_CONTROL.has(cp)) || cp === 0x7f;
    const loneSurrogate = cp >= 0xd800 && cp <= 0xdfff;
    if (control || loneSurrogate) {
      const codepoint = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      throw new HttpError(
        400,
        "malformed_message_character",
        `reply text contains invalid character at ${String(position)}`,
        { position, codepoint },
      );
    }
  });
}

export interface CommentView {
  id: string;
  telegram_message_id: number;
  reply_to: string | null;
  text: string;
  author_name: string | null;
  author_username: string | null;
  author_id: string | null;
  has_replies: boolean;
  posted_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export function serializeComment(c: CommentItem): CommentView {
  return {
    id: c.id,
    telegram_message_id: c.telegramMessageId,
    reply_to: c.replyTo,
    text: c.text,
    author_name: c.authorName,
    author_username: c.authorUsername,
    author_id: c.authorId === null ? null : String(c.authorId),
    has_replies: c.hasReplies,
    posted_at: c.postedAt.toISOString(),
    edited_at: c.editedAt?.toISOString() ?? null,
    deleted_at: c.deletedAt?.toISOString() ?? null,
  };
}

async function requirePost(deps: Deps, postId: string): Promise<PostRow> {
  const post = await getPost(deps.db, postId);
  if (post === null) throw new HttpError(404, "post_not_found", `post ${postId} not found`);
  return post;
}

async function requireComment(deps: Deps, postId: string, commentId: string): Promise<CommentRow> {
  const comment = await getComment(deps.db, { id: commentId, postId });
  if (comment === null) {
    throw new HttpError(404, "comment_not_found", `comment ${commentId} not found`);
  }
  return comment;
}

export async function listComments(
  deps: Deps,
  input: { postId: string; page: PageQuery },
): Promise<PageResult<CommentView>> {
  await requirePost(deps, input.postId);
  const rows = await listTopLevel(deps.db, input.postId, input.page);
  const page = toPage(rows, input.page.limit);
  return { ...page, items: page.items.map(serializeComment) };
}

export async function listCommentReplies(
  deps: Deps,
  input: { postId: string; commentId: string; page: PageQuery },
): Promise<PageResult<CommentView>> {
  await requirePost(deps, input.postId);
  await requireComment(deps, input.postId, input.commentId);
  const rows = await listReplies(deps.db, input.commentId, input.page);
  const page = toPage(rows, input.page.limit);
  return { ...page, items: page.items.map(serializeComment) };
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function deletedComment(commentId: string): HttpError {
  return new HttpError(404, "comment_not_found", `comment ${commentId} was deleted`);
}

export async function replyToComment(
  deps: Deps,
  input: { postId: string; commentId: string; text: string },
): Promise<CommentView> {
  // 1. validate before touching Telegram
  validateReplyText(input.text);

  // 2. load the post, then the comment
  const post = await requirePost(deps, input.postId);
  if (post.deletedAt !== null) {
    throw new HttpError(404, "post_not_found", `post ${input.postId} was deleted`);
  }
  const comment = await requireComment(deps, input.postId, input.commentId);
  if (comment.deletedAt !== null) throw deletedComment(input.commentId);
  const coords = threadCoordinates(post);
  const ctx = { username: post.username, commentId: input.commentId };

  try {
    const client = await deps.telegram(post.username);

    // 3. re-read the target and refresh the row before answering
    const [current] = await client.getMessages(coords.chatId, [comment.telegramMessageId]);
    if (current === undefined || current.kind === "deleted") {
      await markDeleted(deps.db, comment.id, deps.now());
      throw deletedComment(input.commentId);
    }
    if (!sameInstant(current.editedAt, comment.editedAt)) {
      const refreshed = await refreshFromMessage(deps.db, comment.id, {
        text: current.text,
        editedAt: current.editedAt,
      });
      throw new HttpError(
        409,
        "comment_edited",
        `comment ${input.commentId} was edited since it was stored`,
        { comment: serializeComment(await withHasReplies(deps.db, refreshed)) },
      );
    }

    // 4. send: resolve the account first, so a failure there posts nothing
    const self = await client.resolveUser(post.username);
    let sent: Sent;
    try {
      sent = await client.sendReply(
        coords.chatId,
        comment.telegramMessageId,
        input.text,
        coords.topicId,
      );
    } catch (e: unknown) {
      if (isTelegramError(e) && e.kind === "message_not_found") {
        await markDeleted(deps.db, comment.id, deps.now());
      }
      throw e;
    }

    // 5. store the reply as an ordinary comment row
    const row = await insertReply(deps.db, {
      postId: post.id,
      telegramMessageId: sent.messageId,
      replyToMessageId: comment.telegramMessageId,
      replyTo: comment.id,
      authorId: self.id,
      authorUsername: post.username,
      authorName: self.name,
      text: input.text,
      postedAt: sent.postedAt,
      editedAt: null,
    });
    return serializeComment(await withHasReplies(deps.db, row));
  } catch (e: unknown) {
    if (e instanceof HttpError) throw e;
    return translateReplyError(e, ctx);
  }
}
