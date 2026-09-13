import { z } from "zod";
import { HttpError } from "../../../api/errors.ts";
import type { Infra } from "../../../deps.ts";
import { ensureActiveJob, getJobByPost, setJobActive } from "../../../sync/models/jobs.ts";
import type { PeerKind } from "../../client/types.ts";
import { getPost, type PostRow, softDeletePost, upsertPost } from "../../models/posts.ts";
import { translateSubmitError } from "../errors.ts";

export interface ParsedPostUrl {
  ref: string | number;
  messageId: number;
  topicId: number | null;
}

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const DIGITS = /^\d+$/;

function malformed(message: string): HttpError {
  return new HttpError(400, "malformed_url", message);
}

function channelId(raw: string): number {
  const bare = raw.startsWith("-100") ? raw.slice(4) : raw;
  if (!DIGITS.test(bare)) throw malformed("url does not match any supported form");
  return Number(bare);
}

function messageId(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || !DIGITS.test(raw)) {
    throw malformed("url does not match any supported form");
  }
  return Number(raw);
}

function withTopic(ref: string | number, topic: string, id: string): ParsedPostUrl {
  const topicId = messageId(topic);
  const msg = messageId(id);
  if (topicId !== msg) throw malformed("forum link must point at the topic root");
  return { ref, messageId: msg, topicId };
}

function refuseCommentLink(params: URLSearchParams): void {
  if (params.has("comment")) throw malformed("links to a specific comment are not supported");
}

export function parsePostUrl(input: string): ParsedPostUrl {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw malformed("url does not match any supported form");
  }

  if (url.protocol === "tg:") {
    refuseCommentLink(url.searchParams);
    const post = url.searchParams.get("post");
    const thread = url.searchParams.get("thread");
    if (url.hostname === "resolve") {
      const domain = url.searchParams.get("domain");
      if (domain === null || !USERNAME.test(domain)) {
        throw malformed("url does not match any supported form");
      }
      return thread === null
        ? { ref: domain, messageId: messageId(post), topicId: null }
        : withTopic(domain, thread, post ?? "");
    }
    if (url.hostname === "privatepost") {
      const channel = url.searchParams.get("channel");
      if (channel === null) throw malformed("url does not match any supported form");
      const ref = channelId(channel);
      return thread === null
        ? { ref, messageId: messageId(post), topicId: null }
        : withTopic(ref, thread, post ?? "");
    }
    throw malformed("url does not match any supported form");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw malformed("url does not match any supported form");
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host !== "t.me" && host !== "telegram.me") {
    throw malformed("url does not match any supported form");
  }
  refuseCommentLink(url.searchParams);
  const segments = url.pathname.split("/").filter((s) => s !== "");

  if (segments[0] === "c") {
    const [, channel, a, b] = segments;
    if (channel === undefined || a === undefined) {
      throw malformed("url does not match any supported form");
    }
    const ref = channelId(channel);
    if (segments.length === 3) return { ref, messageId: messageId(a), topicId: null };
    if (segments.length === 4 && b !== undefined) return withTopic(ref, a, b);
    throw malformed("url does not match any supported form");
  }

  const [username, a, b] = segments;
  if (username === undefined || a === undefined || !USERNAME.test(username)) {
    throw malformed("url does not match any supported form");
  }
  if (segments.length === 2) return { ref: username, messageId: messageId(a), topicId: null };
  if (segments.length === 3 && b !== undefined) return withTopic(username, a, b);
  throw malformed("url does not match any supported form");
}

export const submitBodySchema = z.object({
  title: z.string().min(1),
  username: z.string().min(1),
  url: z.string().min(1),
});
export type SubmitBody = z.infer<typeof submitBodySchema>;

export interface SubmitResult {
  status: 200 | 201;
  id: string;
  created_at: string;
}

function postTypeOf(kind: PeerKind): PostRow["postType"] {
  switch (kind) {
    case "channel":
      return "channel";
    case "supergroup":
      return "supergroup";
    case "forum":
      return "forum";
  }
}

interface ResolvedPeer {
  peerChatId: number;
  postType: PostRow["postType"];
  discussion: { chatId: number; rootMessageId: number } | null;
}

export async function submitPost(deps: Infra, body: SubmitBody): Promise<SubmitResult> {
  const parsed = parsePostUrl(body.url);

  const resolved = await (async (): Promise<ResolvedPeer> => {
    try {
      const client = await deps.telegram(body.username);
      const peer = await client.resolvePeer(parsed.ref);
      const postType = postTypeOf(peer.kind);
      const discussion = postType === "channel"
        ? await client.getDiscussionThread(peer.chatId, parsed.messageId)
        : null;
      return { peerChatId: peer.chatId, postType, discussion };
    } catch (e: unknown) {
      translateSubmitError(e, { username: body.username });
    }
  })();

  const { post, created } = await deps.db.transaction(async (tx) => {
    const result = await upsertPost(tx, {
      username: body.username,
      title: body.title,
      url: body.url,
      postType: resolved.postType,
      messageId: parsed.messageId,
      channelId: resolved.peerChatId,
      forumTopicId: resolved.postType === "forum" ? parsed.messageId : null,
      discussionChatId: resolved.discussion?.chatId ?? null,
      discussionMessageId: resolved.discussion?.rootMessageId ?? null,
    });
    await ensureActiveJob(tx, { postId: result.post.id, platform: "telegram" });
    return result;
  });

  return { status: created ? 201 : 200, id: post.id, created_at: post.createdAt.toISOString() };
}

export interface PostView {
  status: 200;
  id: string;
  username: string;
  title: string;
  url: string;
  comments_synced_at: string | null;
  sync_error: string | null;
  comment_sync_enabled: boolean;
  created_at: string;
  deleted_at: string | null;
}

export function serializePost(post: PostRow, job: { isActive: boolean } | null): PostView {
  return {
    status: 200,
    id: post.id,
    username: post.username,
    title: post.title,
    url: post.url,
    comments_synced_at: post.lastSyncedAt?.toISOString() ?? null,
    sync_error: post.syncError,
    comment_sync_enabled: job?.isActive ?? false,
    created_at: post.createdAt.toISOString(),
    deleted_at: post.deletedAt?.toISOString() ?? null,
  };
}

export async function getPostView(deps: Infra, id: string): Promise<PostView> {
  const post = await getPost(deps.db, id);
  if (post === null) throw new HttpError(404, "post_not_found", `post ${id} not found`);
  const job = await getJobByPost(deps.db, { postId: id, platform: "telegram" });
  return serializePost(post, job);
}

export async function deletePost(
  deps: Infra,
  id: string,
): Promise<{ status: 200; id: string; deleted_at: string }> {
  const deleted = await deps.db.transaction(async (tx) => {
    const post = await softDeletePost(tx, id, deps.now());
    if (post === null) return null;
    await setJobActive(tx, { postId: id, platform: "telegram" }, false);
    return post;
  });
  if (deleted === null) {
    throw new HttpError(404, "post_not_found", `post ${id} not found`);
  }
  if (deleted.deletedAt === null) {
    throw new Error(`post ${id} was just soft-deleted but has no deleted_at`);
  }
  return { status: 200, id, deleted_at: deleted.deletedAt.toISOString() };
}
