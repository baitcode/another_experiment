import { assert, assertEquals } from "@std/assert";
import { withDb } from "../../db/tests/helpers.ts";
import type { Db } from "../../db/client.ts";
import type { Message } from "../client/types.ts";
import {
  getComment,
  insertFromMessages,
  insertReply,
  listReplies,
  listTopLevel,
  markDeleted,
  refreshFromMessage,
  withHasReplies,
} from "../models/comments.ts";
import { upsertPost } from "../models/posts.ts";

const ROOT = 50;

function msg(id: number, replyTo: number, text = `m${String(id)}`): Message {
  return {
    kind: "message",
    id,
    replyToMessageId: replyTo,
    author: { id: 1000 + id, username: `u${String(id)}`, name: `User ${String(id)}` },
    text,
    postedAt: new Date(2026, 0, 1, 0, 0, id),
    editedAt: null,
  };
}

async function post(db: Db, username = "alice"): Promise<string> {
  const { post } = await upsertPost(db, {
    username,
    title: "t",
    url: "https://t.me/c/100/5",
    postType: "channel",
    messageId: 5,
    channelId: 100,
    forumTopicId: null,
    discussionChatId: 200,
    discussionMessageId: ROOT,
  });
  return post.id;
}

Deno.test("insertFromMessages stores new rows, resolves reply_to, ignores known ids", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    await insertFromMessages(db, postId, [msg(51, ROOT), msg(52, 51), msg(53, 49)]);
    const top = await listTopLevel(db, postId, { limit: 10, after: null });
    assertEquals(
      top.map((c) => c.telegramMessageId),
      [51, 53],
      "parent never ingested lists top-level",
    );
    assertEquals(top[0]?.hasReplies, true);
    assertEquals(top[1]?.hasReplies, false);
    assertEquals(top[0]?.authorId, 1051);
    assertEquals(top[0]?.authorUsername, "u51");
    const [reply] = await listReplies(db, top[0]?.id ?? "", { limit: 10, after: null });
    assertEquals(reply?.telegramMessageId, 52);
    assertEquals(reply?.replyToMessageId, 51);
    await insertFromMessages(db, postId, [msg(51, ROOT, "changed"), msg(54, 52)]);
    const again = await listTopLevel(db, postId, { limit: 10, after: null });
    assertEquals(again[0]?.text, "m51", "known rows are left as they are");
    const nested = await listReplies(db, reply?.id ?? "", { limit: 10, after: null });
    assertEquals(nested.map((c) => c.telegramMessageId), [54], "parent from an earlier page");
  });
});

Deno.test("anonymous messages store null author fields", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    await insertFromMessages(db, postId, [{ ...msg(51, ROOT), author: null }]);
    const [row] = await listTopLevel(db, postId, { limit: 10, after: null });
    assertEquals(row?.authorId, null);
    assertEquals(row?.authorName, null);
  });
});

Deno.test("insertReply returns the existing row when the sync got there first", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    await insertFromMessages(db, postId, [msg(51, ROOT)]);
    const [parent] = await listTopLevel(db, postId, { limit: 10, after: null });
    assert(parent !== undefined);
    const input = {
      postId,
      telegramMessageId: 60,
      replyToMessageId: 51,
      replyTo: parent.id,
      authorId: 1,
      authorUsername: "alice",
      authorName: "Alice",
      text: "thanks",
      postedAt: new Date(),
      editedAt: null,
    };
    const a = await insertReply(db, input);
    const b = await insertReply(db, { ...input, text: "other" });
    assertEquals(a.id, b.id);
    assertEquals(b.text, "thanks");
    await insertFromMessages(db, postId, [msg(60, 51, "from sync")]);
    const [again] = await listReplies(db, parent.id, { limit: 10, after: null });
    assertEquals(again?.text, "thanks", "the sync skips the row the reply wrote");
  });
});

Deno.test("listings page by id ascending and fetch one extra row", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    await insertFromMessages(db, postId, [
      msg(51, ROOT),
      msg(52, ROOT),
      msg(53, ROOT),
      msg(54, 51),
    ]);
    const first = await listTopLevel(db, postId, { limit: 2, after: null });
    assertEquals(first.length, 3, "limit + 1");
    const after = first[1]?.id ?? "";
    const second = await listTopLevel(db, postId, { limit: 2, after });
    assertEquals(second.map((c) => c.telegramMessageId), [53]);
    const other = await post(db, "bob");
    assertEquals((await listTopLevel(db, other, { limit: 10, after: null })).length, 0);
  });
});

Deno.test("getComment is scoped by post; markDeleted and refreshFromMessage update the row", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    const other = await post(db, "bob");
    await insertFromMessages(db, postId, [msg(51, ROOT)]);
    const [row] = await listTopLevel(db, postId, { limit: 10, after: null });
    assert(row !== undefined);
    assertEquals((await getComment(db, { id: row.id, postId }))?.id, row.id);
    assertEquals(await getComment(db, { id: row.id, postId: other }), null);
    const edited = await refreshFromMessage(db, row.id, {
      text: "new",
      editedAt: new Date("2026-01-02T08:00:00Z"),
    });
    assertEquals(edited.text, "new");
    assertEquals(edited.editedAt?.toISOString(), "2026-01-02T08:00:00.000Z");
    const gone = await markDeleted(db, row.id, new Date("2026-01-03T00:00:00Z"));
    assertEquals(gone.deletedAt?.toISOString(), "2026-01-03T00:00:00.000Z");
    const item = await withHasReplies(db, gone);
    assertEquals(item.hasReplies, false);
    const still = await listTopLevel(db, postId, { limit: 10, after: null });
    assertEquals(still.length, 1, "deleted rows still list");
  });
});
