import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const postTypes = ["channel", "forum", "supergroup"] as const;
export type PostType = (typeof postTypes)[number];

export const telegramPosts = pgTable(
  "telegram_posts",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    username: text("username").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    postType: text("post_type").$type<PostType>().notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    forumTopicId: bigint("forum_topic_id", { mode: "number" }),
    discussionChatId: bigint("discussion_chat_id", { mode: "number" }),
    discussionMessageId: bigint("discussion_message_id", { mode: "number" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncedMessageId: bigint("last_synced_message_id", { mode: "number" }),
    syncError: text("sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "telegram_posts_post_type_check",
      sql`${t.postType} in ('channel', 'forum', 'supergroup')`,
    ),
    uniqueIndex("telegram_posts_username_channel_message_uniq").on(
      t.username,
      t.channelId,
      t.messageId,
    ),
  ],
);

export const telegramComments = pgTable(
  "telegram_comments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    postId: uuid("post_id").notNull().references(() => telegramPosts.id),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    replyToMessageId: bigint("reply_to_message_id", { mode: "number" }).notNull(),
    replyTo: uuid("reply_to").references((): AnyPgColumn => telegramComments.id),
    authorId: bigint("author_id", { mode: "number" }),
    authorUsername: text("author_username"),
    authorName: text("author_name"),
    text: text("text").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("telegram_comments_post_message_uniq").on(t.postId, t.telegramMessageId),
    index("telegram_comments_reply_to_idx")
      .on(t.replyTo, t.id)
      .where(sql`${t.replyTo} is not null`),
    index("telegram_comments_top_level_idx")
      .on(t.postId, t.id)
      .where(sql`${t.replyTo} is null`),
  ],
);
