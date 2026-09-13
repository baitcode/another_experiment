import { eq, getTableColumns, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { type PostType, telegramPosts } from "./schema.ts";

export type PostRow = typeof telegramPosts.$inferSelect;

export interface NewPost {
  username: string;
  title: string;
  url: string;
  postType: PostType;
  messageId: number;
  channelId: number;
  forumTopicId: number | null;
  discussionChatId: number | null;
  discussionMessageId: number | null;
}

export interface ThreadCoordinates {
  chatId: number;
  rootMessageId: number;
  topicId: number | null;
}

/**
 * Insert, or on (username, channel_id, message_id) restore: clear deleted_at and sync_error.
 * Nothing else is rewritten; the thread is fixed when the post is published.
 */
export async function upsertPost(
  ex: Executor,
  input: NewPost,
): Promise<{ post: PostRow; created: boolean }> {
  const rows = await ex
    .insert(telegramPosts)
    .values(input)
    .onConflictDoUpdate({
      target: [telegramPosts.username, telegramPosts.channelId, telegramPosts.messageId],
      set: { deletedAt: null, syncError: null, updatedAt: sql`now()` },
    })
    .returning({ ...getTableColumns(telegramPosts), created: sql<boolean>`(xmax = 0)` });
  const row = rows[0];
  if (row === undefined) throw new Error("upsertPost returned no row");
  const { created, ...post } = row;
  return { post, created };
}

export async function getPost(ex: Executor, id: string): Promise<PostRow | null> {
  const rows = await ex.select().from(telegramPosts).where(eq(telegramPosts.id, id));
  return rows[0] ?? null;
}

export async function softDeletePost(
  ex: Executor,
  id: string,
  at: Date,
): Promise<PostRow | null> {
  const rows = await ex
    .update(telegramPosts)
    .set({
      deletedAt: sql`coalesce(${telegramPosts.deletedAt}, ${at.toISOString()}::timestamptz)`,
      updatedAt: sql`now()`,
    })
    .where(eq(telegramPosts.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function markSyncSuccess(
  ex: Executor,
  postId: string,
  input: { lastSyncedMessageId: number | null; at: Date },
): Promise<void> {
  await ex
    .update(telegramPosts)
    .set({
      lastSyncedAt: input.at,
      lastSyncedMessageId: input.lastSyncedMessageId ?? telegramPosts.lastSyncedMessageId,
      syncError: null,
      updatedAt: sql`now()`,
    })
    .where(eq(telegramPosts.id, postId));
}

export async function markSyncFailure(
  ex: Executor,
  postId: string,
  error: string,
  at: Date,
): Promise<void> {
  await ex
    .update(telegramPosts)
    .set({ syncError: error, updatedAt: at })
    .where(eq(telegramPosts.id, postId));
}

export function threadCoordinates(post: PostRow): ThreadCoordinates {
  switch (post.postType) {
    case "channel": {
      if (post.discussionChatId === null || post.discussionMessageId === null) {
        throw new Error(`channel post ${post.id} has no discussion thread stored`);
      }
      return {
        chatId: post.discussionChatId,
        rootMessageId: post.discussionMessageId,
        topicId: null,
      };
    }
    case "supergroup":
      return { chatId: post.channelId, rootMessageId: post.messageId, topicId: null };
    case "forum": {
      if (post.forumTopicId === null) {
        throw new Error(`forum post ${post.id} has no topic id stored`);
      }
      return {
        chatId: post.channelId,
        rootMessageId: post.forumTopicId,
        topicId: post.forumTopicId,
      };
    }
  }
}
