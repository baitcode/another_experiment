import { assertEquals, assertThrows } from "@std/assert";
import { withDb } from "../../db/tests/helpers.ts";
import {
  getPost,
  markSyncFailure,
  markSyncSuccess,
  type NewPost,
  softDeletePost,
  threadCoordinates,
  upsertPost,
} from "../models/posts.ts";

const channelPost: NewPost = {
  username: "alice",
  title: "Hello",
  url: "https://t.me/mychannel/5",
  postType: "channel",
  messageId: 5,
  channelId: 100,
  forumTopicId: null,
  discussionChatId: 200,
  discussionMessageId: 50,
};

Deno.test("upsertPost creates, then restores on conflict without rewriting the thread", async () => {
  await withDb(async (db) => {
    const first = await upsertPost(db, channelPost);
    assertEquals(first.created, true);
    await softDeletePost(db, first.post.id, new Date());
    await markSyncFailure(db, first.post.id, "boom", new Date());
    const second = await upsertPost(db, {
      ...channelPost,
      title: "Renamed",
      url: "tg://resolve?domain=mychannel&post=5",
      discussionChatId: 999,
      discussionMessageId: 999,
    });
    assertEquals(second.created, false);
    assertEquals(second.post.id, first.post.id);
    assertEquals(second.post.deletedAt, null);
    assertEquals(second.post.syncError, null);
    assertEquals(second.post.discussionChatId, 200, "thread coordinates are fixed at publish");
    assertEquals(second.post.title, "Hello", "existing attributes are kept");
    const other = await upsertPost(db, { ...channelPost, username: "bob" });
    assertEquals(other.created, true);
  });
});

Deno.test("softDeletePost sets deleted_at once and returns the row; unknown id is null", async () => {
  await withDb(async (db) => {
    const { post } = await upsertPost(db, channelPost);
    const t1 = new Date("2026-01-01T00:00:00Z");
    const a = await softDeletePost(db, post.id, t1);
    const b = await softDeletePost(db, post.id, new Date("2026-02-01T00:00:00Z"));
    assertEquals(a?.deletedAt?.toISOString(), t1.toISOString());
    assertEquals(b?.deletedAt?.toISOString(), t1.toISOString());
    assertEquals(await softDeletePost(db, "0199a000-0000-7000-8000-000000000001", t1), null);
    assertEquals(await getPost(db, "0199a000-0000-7000-8000-000000000001"), null);
  });
});

Deno.test("sync marks: success moves the mark and clears the error; empty page keeps the mark", async () => {
  await withDb(async (db) => {
    const { post } = await upsertPost(db, channelPost);
    await markSyncFailure(db, post.id, "flood_wait: 30", new Date());
    assertEquals((await getPost(db, post.id))?.syncError, "flood_wait: 30");
    const at = new Date("2026-01-01T00:00:00Z");
    await markSyncSuccess(db, post.id, { lastSyncedMessageId: 77, at });
    let row = await getPost(db, post.id);
    assertEquals(row?.lastSyncedMessageId, 77);
    assertEquals(row?.syncError, null);
    assertEquals(row?.lastSyncedAt?.toISOString(), at.toISOString());
    await markSyncSuccess(db, post.id, { lastSyncedMessageId: null, at: new Date() });
    row = await getPost(db, post.id);
    assertEquals(row?.lastSyncedMessageId, 77);
  });
});

Deno.test("threadCoordinates by post type", async () => {
  await withDb(async (db) => {
    const { post: channel } = await upsertPost(db, channelPost);
    assertEquals(threadCoordinates(channel), { chatId: 200, rootMessageId: 50, topicId: null });
    const { post: group } = await upsertPost(db, {
      ...channelPost,
      postType: "supergroup",
      channelId: 300,
      messageId: 7,
      discussionChatId: null,
      discussionMessageId: null,
    });
    assertEquals(threadCoordinates(group), { chatId: 300, rootMessageId: 7, topicId: null });
    const { post: forum } = await upsertPost(db, {
      ...channelPost,
      postType: "forum",
      channelId: 400,
      messageId: 9,
      forumTopicId: 9,
      discussionChatId: null,
      discussionMessageId: null,
    });
    assertEquals(threadCoordinates(forum), { chatId: 400, rootMessageId: 9, topicId: 9 });
    assertThrows(() => threadCoordinates({ ...channel, discussionChatId: null }));
  });
});
