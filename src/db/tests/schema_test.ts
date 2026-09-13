import { assert, assertEquals, assertRejects } from "@std/assert";
import { sql } from "drizzle-orm";
import { telegramPosts } from "../../telegram/models/schema.ts";
import { postCommentsSyncJobs } from "../../sync/models/schema.ts";
import { withDb } from "./helpers.ts";

Deno.test("migrations create tables with uuidv7 ids", async () => {
  await withDb(async (db) => {
    const [post] = await db
      .insert(telegramPosts)
      .values({
        username: "u",
        title: "t",
        url: "https://t.me/u/1",
        postType: "channel",
        messageId: 1,
        channelId: 10,
      })
      .returning();
    assert(post !== undefined);
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/.test(post.id), "uuidv7 id");
    const [job] = await db
      .insert(postCommentsSyncJobs)
      .values({ postId: post.id, platform: "telegram" })
      .returning();
    assert(job !== undefined);
    assertEquals(job.isActive, true);
  });
});

Deno.test("one tracked post per (username, channel, message)", async () => {
  await withDb(async (db) => {
    const row = {
      username: "u",
      title: "t",
      url: "https://t.me/u/1",
      postType: "channel" as const,
      messageId: 1,
      channelId: 10,
    };
    await db.insert(telegramPosts).values(row);
    await assertRejects(() => db.insert(telegramPosts).values(row));
    await db.insert(telegramPosts).values({ ...row, username: "other" });
  });
});

Deno.test("post_type is checked", async () => {
  await withDb(async (db) => {
    await assertRejects(() =>
      db.execute(
        sql`insert into telegram_posts (username, title, url, post_type, message_id, channel_id)
            values ('u', 't', 'x', 'story', 1, 1)`,
      )
    );
  });
});
