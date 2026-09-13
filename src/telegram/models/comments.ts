import { and, asc, eq, exists, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Executor } from "../../db/client.ts";
import type { Message } from "../client/types.ts";
import { telegramComments } from "./schema.ts";

export type CommentRow = typeof telegramComments.$inferSelect;

export interface CommentItem extends CommentRow {
  hasReplies: boolean;
}

export interface NewComment {
  postId: string;
  telegramMessageId: number;
  replyToMessageId: number;
  replyTo: string | null;
  authorId: number | null;
  authorUsername: string | null;
  authorName: string | null;
  text: string;
  postedAt: Date;
  editedAt: Date | null;
}

export interface PageArgs {
  limit: number;
  after: string | null;
}

const replies = alias(telegramComments, "r");

function hasRepliesExpr(ex: Executor) {
  return exists(
    ex.select({ one: sql`1` }).from(replies).where(eq(replies.replyTo, telegramComments.id)),
  );
}

function selectItems(ex: Executor) {
  return {
    id: telegramComments.id,
    postId: telegramComments.postId,
    telegramMessageId: telegramComments.telegramMessageId,
    replyToMessageId: telegramComments.replyToMessageId,
    replyTo: telegramComments.replyTo,
    authorId: telegramComments.authorId,
    authorUsername: telegramComments.authorUsername,
    authorName: telegramComments.authorName,
    text: telegramComments.text,
    postedAt: telegramComments.postedAt,
    editedAt: telegramComments.editedAt,
    deletedAt: telegramComments.deletedAt,
    createdAt: telegramComments.createdAt,
    updatedAt: telegramComments.updatedAt,
    hasReplies: sql<boolean>`${hasRepliesExpr(ex)}`.mapWith(Boolean),
  };
}

/**
 * Sync step 3: insert the page with `on conflict do nothing`, then set reply_to on the new rows
 * by joining reply_to_message_id to the post's comments. The thread root is not a comment row,
 * so top-level comments stay null, as does a reply whose parent never came through.
 */
export async function insertFromMessages(
  ex: Executor,
  postId: string,
  messages: Message[],
): Promise<void> {
  if (messages.length === 0) return;
  await ex
    .insert(telegramComments)
    .values(
      messages.map((m) => ({
        postId,
        telegramMessageId: m.id,
        replyToMessageId: m.replyToMessageId,
        replyTo: null,
        authorId: m.author?.id ?? null,
        authorUsername: m.author?.username ?? null,
        authorName: m.author?.name ?? null,
        text: m.text,
        postedAt: m.postedAt,
        editedAt: m.editedAt,
      })),
    )
    .onConflictDoNothing({
      target: [telegramComments.postId, telegramComments.telegramMessageId],
    });
  const ids = messages.map((m) => m.id);
  await ex.execute(sql`
    update telegram_comments c
      set reply_to = p.id
    from telegram_comments p
    where c.post_id = ${postId}
      and p.post_id = ${postId}
      and c.reply_to is null
      and c.telegram_message_id in ${ids}
      and p.telegram_message_id = c.reply_to_message_id
  `);
}

/** Reply step 5: insert the sent reply; on conflict the sync's row is complete, so use it. */
export async function insertReply(ex: Executor, input: NewComment): Promise<CommentRow> {
  const inserted = await ex
    .insert(telegramComments)
    .values(input)
    .onConflictDoNothing({
      target: [telegramComments.postId, telegramComments.telegramMessageId],
    })
    .returning();
  const row = inserted[0];
  if (row !== undefined) return row;
  const existing = await ex
    .select()
    .from(telegramComments)
    .where(
      and(
        eq(telegramComments.postId, input.postId),
        eq(telegramComments.telegramMessageId, input.telegramMessageId),
      ),
    );
  const found = existing[0];
  if (found === undefined) throw new Error("insertReply: conflict row vanished");
  return found;
}

export async function getComment(
  ex: Executor,
  key: { id: string; postId: string },
): Promise<CommentRow | null> {
  const rows = await ex
    .select()
    .from(telegramComments)
    .where(and(eq(telegramComments.id, key.id), eq(telegramComments.postId, key.postId)));
  return rows[0] ?? null;
}

/** Top-level rows of a post, paged by id through the (post_id, id) partial index. Fetches limit + 1. */
export function listTopLevel(ex: Executor, postId: string, page: PageArgs): Promise<CommentItem[]> {
  const where = [eq(telegramComments.postId, postId), isNull(telegramComments.replyTo)];
  if (page.after !== null) where.push(gt(telegramComments.id, page.after));
  return ex
    .select(selectItems(ex))
    .from(telegramComments)
    .where(and(...where))
    .orderBy(asc(telegramComments.id))
    .limit(page.limit + 1);
}

/** Direct children of a comment, paged by id through the (reply_to, id) partial index. Fetches limit + 1. */
export function listReplies(
  ex: Executor,
  commentId: string,
  page: PageArgs,
): Promise<CommentItem[]> {
  const where = [eq(telegramComments.replyTo, commentId)];
  if (page.after !== null) where.push(gt(telegramComments.id, page.after));
  return ex
    .select(selectItems(ex))
    .from(telegramComments)
    .where(and(...where))
    .orderBy(asc(telegramComments.id))
    .limit(page.limit + 1);
}

export async function markDeleted(ex: Executor, id: string, at: Date): Promise<CommentRow> {
  const rows = await ex
    .update(telegramComments)
    .set({
      deletedAt: sql`coalesce(${telegramComments.deletedAt}, ${at.toISOString()}::timestamptz)`,
      updatedAt: sql`now()`,
    })
    .where(eq(telegramComments.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`comment ${id} not found`);
  return row;
}

export async function refreshFromMessage(
  ex: Executor,
  id: string,
  input: { text: string; editedAt: Date | null },
): Promise<CommentRow> {
  const rows = await ex
    .update(telegramComments)
    .set({ text: input.text, editedAt: input.editedAt, updatedAt: sql`now()` })
    .where(eq(telegramComments.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`comment ${id} not found`);
  return row;
}

export async function withHasReplies(ex: Executor, row: CommentRow): Promise<CommentItem> {
  const rows = await ex
    .select({ id: replies.id })
    .from(replies)
    .where(eq(replies.replyTo, row.id))
    .limit(1);
  return { ...row, hasReplies: rows.length > 0 };
}
