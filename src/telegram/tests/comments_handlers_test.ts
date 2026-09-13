import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError } from "../../api/errors.ts";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import type { Infra } from "../../deps.ts";
import { Forbidden, PeerNotFound } from "../client/errors.ts";
import { FakeTelegram } from "../client/fake.ts";
import type { Message } from "../client/types.ts";
import {
  listCommentReplies,
  listComments,
  replyToComment,
  validateReplyText,
} from "../api/handlers/comments.ts";
import { deletePost, submitPost } from "../api/handlers/posts.ts";
import { insertFromMessages } from "../models/comments.ts";

const CHAT = 200;
const ROOT = 50;
const UNKNOWN = "0199a000-0000-7000-8000-000000000001";
const page10 = { limit: 10, after: null };

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

async function world(db: Db): Promise<{ deps: Infra; fake: FakeTelegram; postId: string }> {
  const fake = new FakeTelegram();
  fake.clock = () => new Date("2026-01-01T10:15:30Z");
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.linkDiscussion(100, 5, { chatId: CHAT, rootMessageId: ROOT });
  const deps: Infra = {
    db,
    telegram: (u) => fake.forUser(u),
    now: () => new Date("2026-01-01T10:15:30Z"),
  };
  const { id } = await submitPost(deps, {
    title: "p",
    username: "alice",
    url: "https://t.me/mychannel/5",
  });
  // the same messages on Telegram and in the database, as after one sync run
  const messages = [msg(51, ROOT), msg(52, 51), msg(53, ROOT)];
  for (const m of messages) {
    fake.addMessage(CHAT, ROOT, {
      id: m.id,
      replyToMessageId: m.replyToMessageId,
      text: m.text,
      author: m.author,
      postedAt: m.postedAt,
    });
  }
  await insertFromMessages(db, id, messages);
  return { deps, fake, postId: id };
}

async function expectHttp(p: Promise<unknown>, status: number, code: string): Promise<HttpError> {
  const err = await assertRejects(() => p, HttpError);
  assertEquals([err.status, err.code], [status, code]);
  return err;
}

Deno.test("validateReplyText", () => {
  validateReplyText("fine\nwith newline\tand tab");
  let err = assertThrows(() => {
    validateReplyText("");
  }, HttpError);
  assertEquals([err.code, err.message], ["malformed_message", "reply text can not be empty"]);
  err = assertThrows(() => {
    validateReplyText("   ");
  }, HttpError);
  assertEquals(err.message, "reply text can not be empty");
  err = assertThrows(() => {
    validateReplyText("x".repeat(4097));
  }, HttpError);
  assertEquals([err.code, err.message], ["malformed_message", "reply text is too long"]);
  err = assertThrows(() => {
    validateReplyText("ok\u0000bad");
  }, HttpError);
  assertEquals(err.code, "malformed_message_character");
  assertEquals(err.message, "reply text contains invalid character at 2");
  assertEquals(err.extra, { position: 2, codepoint: "U+0000" });
  err = assertThrows(() => {
    validateReplyText("\u{1F600}\u0007");
  }, HttpError);
  assertEquals(err.extra, { position: 1, codepoint: "U+0007" });
});

Deno.test("listComments pages top-level items with has_replies and string author ids", async () => {
  await withDb(async (db) => {
    const { deps, postId } = await world(db);
    const page1 = await listComments(deps, { postId, page: { limit: 1, after: null } });
    assertEquals(page1.items.length, 1);
    assertEquals(page1.has_more, true);
    assert(page1.next_cursor !== null);
    assertEquals(page1.items[0]?.telegram_message_id, 51);
    assertEquals(page1.items[0]?.has_replies, true);
    assertEquals(page1.items[0]?.author_id, "1051");
    assertEquals(page1.items[0]?.reply_to, null);
    const after = (JSON.parse(atob(page1.next_cursor)) as { after: string }).after;
    const page2 = await listComments(deps, { postId, page: { limit: 1, after } });
    assertEquals(page2.items[0]?.telegram_message_id, 53);
    assertEquals(page2.next_cursor, null);
    await deletePost(deps, postId);
    const afterDelete = await listComments(deps, { postId, page: page10 });
    assertEquals(afterDelete.items.length, 2, "a deleted post still lists");
    await expectHttp(listComments(deps, { postId: UNKNOWN, page: page10 }), 404, "post_not_found");
  });
});

Deno.test("listCommentReplies returns direct children; unknown ids are 404", async () => {
  await withDb(async (db) => {
    const { deps, postId } = await world(db);
    const [parent] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined);
    const replies = await listCommentReplies(deps, { postId, commentId: parent.id, page: page10 });
    assertEquals(replies.items.map((r) => r.telegram_message_id), [52]);
    assertEquals(replies.items[0]?.reply_to, parent.id);
    await expectHttp(
      listCommentReplies(deps, { postId, commentId: UNKNOWN, page: page10 }),
      404,
      "comment_not_found",
    );
    await expectHttp(
      listCommentReplies(deps, { postId: UNKNOWN, commentId: parent.id, page: page10 }),
      404,
      "post_not_found",
    );
  });
});

Deno.test("reply: sends, stores the account's row, lists as a reply", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    const [parent] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined);
    const view = await replyToComment(deps, { postId, commentId: parent.id, text: "thanks" });
    assertEquals(view.reply_to, parent.id);
    assertEquals(view.text, "thanks");
    assertEquals([view.author_username, view.author_id, view.author_name], ["alice", "1", "Alice"]);
    assertEquals(view.has_replies, false);
    assertEquals(view.posted_at, "2026-01-01T10:15:30.000Z");
    const sent = fake.calls.filter((c) => c.startsWith("sendReply"));
    assertEquals(sent, [`sendReply(${String(CHAT)}, 51, "thanks", null)`]);
    const replies = await listCommentReplies(deps, { postId, commentId: parent.id, page: page10 });
    assertEquals(replies.items.map((r) => r.telegram_message_id), [52, view.telegram_message_id]);
    // the next sync sees the reply on Telegram and skips it
    const client = await fake.forUser("alice");
    const page = await client.getThreadMessages(CHAT, ROOT, 53, 100);
    await insertFromMessages(db, postId, page.messages);
    const again = await listCommentReplies(deps, { postId, commentId: parent.id, page: page10 });
    assertEquals(again.items.length, 2);
  });
});

Deno.test("reply refusals: validation, deleted comment, deleted post, unknown ids", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    const [parent, other] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined && other !== undefined);
    await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "" }),
      400,
      "malformed_message",
    );
    assertEquals(
      fake.calls.filter((c) => c.startsWith("getMessages")).length,
      0,
      "Telegram untouched",
    );
    // target deleted on Telegram since it was stored
    fake.deleteMessage(CHAT, 53);
    const gone = await expectHttp(
      replyToComment(deps, { postId, commentId: other.id, text: "x" }),
      404,
      "comment_not_found",
    );
    assertEquals(gone.message, `comment ${other.id} was deleted`);
    const listed = await listComments(deps, { postId, page: page10 });
    const row = listed.items.find((c) => c.id === other.id);
    assert(row !== undefined && row.deleted_at !== null, "row marked deleted");
    await expectHttp(
      replyToComment(deps, { postId, commentId: other.id, text: "x" }),
      404,
      "comment_not_found",
    );
    assertEquals(fake.calls.filter((c) => c.startsWith("sendReply")).length, 0);
    await expectHttp(
      replyToComment(deps, { postId, commentId: UNKNOWN, text: "x" }),
      404,
      "comment_not_found",
    );
    await expectHttp(
      replyToComment(deps, { postId: UNKNOWN, commentId: parent.id, text: "x" }),
      404,
      "post_not_found",
    );
    await deletePost(deps, postId);
    const del = await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      404,
      "post_not_found",
    );
    assertEquals(del.message, `post ${postId} was deleted`);
  });
});

Deno.test("reply to an edited comment: 409 with the refreshed item, then the retry goes through", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    const [parent] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined);
    fake.editMessage(CHAT, 51, "m51 edited", new Date("2026-01-02T08:00:00Z"));
    const err = await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      409,
      "comment_edited",
    );
    assertEquals(err.message, `comment ${parent.id} was edited since it was stored`);
    const comment = err.extra.comment as { text: string; edited_at: string; has_replies: boolean };
    assertEquals(
      [comment.text, comment.edited_at, comment.has_replies],
      ["m51 edited", "2026-01-02T08:00:00.000Z", true],
    );
    assertEquals(fake.calls.filter((c) => c.startsWith("sendReply")).length, 0, "nothing posted");
    const ok = await replyToComment(deps, { postId, commentId: parent.id, text: "x" });
    assertEquals(ok.reply_to, parent.id);
  });
});

Deno.test("reply: library errors from for_user, resolve_user and send_reply", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    const [parent] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined);
    fake.failOn("resolveUser", new PeerNotFound("alice"));
    await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      502,
      "upstream_failure",
    );
    fake.failOn("sendReply", new Forbidden("CHAT_WRITE_FORBIDDEN"));
    const forbidden = await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      502,
      "upstream_failure",
    );
    assertEquals(forbidden.extra.upstream_error, "CHAT_WRITE_FORBIDDEN");
    fake.accounts.delete("alice");
    await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      404,
      "user_not_found",
    );
  });
});
