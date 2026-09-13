import { assert, assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "../../api/errors.ts";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import type { Deps } from "../../deps.ts";
import { getJobByPost } from "../../sync/models/jobs.ts";
import { FloodWait, SessionInvalid, Upstream } from "../client/errors.ts";
import { FakeTelegram } from "../client/fake.ts";
import { deletePost, getPostView, submitPost } from "../api/handlers/posts.ts";
import { getPost, markSyncFailure } from "../models/posts.ts";

function world(db: Db): { deps: Deps; fake: FakeTelegram } {
  const fake = new FakeTelegram();
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.addPeer(100, { chatId: 100, kind: "channel" });
  fake.linkDiscussion(100, 5, { chatId: 200, rootMessageId: 50 });
  fake.addPeer("lonely", { chatId: 300, kind: "channel" });
  fake.addPeer("mygroup", { chatId: 400, kind: "supergroup" });
  fake.addPeer("myforum", { chatId: 500, kind: "forum" });
  const deps: Deps = {
    db,
    telegram: (u) => fake.forUser(u),
    now: () => new Date("2026-01-01T10:15:30Z"),
  };
  return { deps, fake };
}

async function expectHttp(p: Promise<unknown>, status: number, code: string): Promise<HttpError> {
  const err = await assertRejects(() => p, HttpError);
  assertEquals([err.status, err.code], [status, code]);
  return err;
}

Deno.test("submit a channel post: 201, thread resolved, job active; resubmit: 200", async () => {
  await withDb(async (db) => {
    const { deps } = world(db);
    const body = { title: "My post", username: "alice", url: "https://t.me/mychannel/5" };
    const created = await submitPost(deps, body);
    assertEquals(created.status, 201);
    const post = await getPost(db, created.id);
    assertEquals(post?.postType, "channel");
    assertEquals(post?.channelId, 100);
    assertEquals(post?.discussionChatId, 200);
    assertEquals(post?.discussionMessageId, 50);
    assertEquals(post?.forumTopicId, null);
    assertEquals(
      (await getJobByPost(db, { postId: created.id, platform: "telegram" }))?.isActive,
      true,
    );
    const again = await submitPost(deps, { ...body, url: "https://t.me/c/100/5" });
    assertEquals(again.status, 200);
    assertEquals(again.id, created.id, "url forms of the same post collapse");
  });
});

Deno.test("resubmitting a deleted post restores it and re-enables the job", async () => {
  await withDb(async (db) => {
    const { deps } = world(db);
    const body = { title: "My post", username: "alice", url: "https://t.me/mychannel/5" };
    const { id } = await submitPost(deps, body);
    await deletePost(deps, id);
    await markSyncFailure(db, id, "old error", new Date());
    assertEquals((await getJobByPost(db, { postId: id, platform: "telegram" }))?.isActive, false);
    const res = await submitPost(deps, body);
    assertEquals(res.status, 200);
    const view = await getPostView(deps, id);
    assertEquals(view.deleted_at, null);
    assertEquals(view.sync_error, null);
    assertEquals(view.comment_sync_enabled, true);
  });
});

Deno.test("supergroup and forum posts store coordinates without a discussion lookup", async () => {
  await withDb(async (db) => {
    const { deps, fake } = world(db);
    const g = await submitPost(deps, {
      title: "g",
      username: "alice",
      url: "https://t.me/mygroup/7",
    });
    const group = await getPost(db, g.id);
    assertEquals([group?.postType, group?.channelId, group?.messageId, group?.forumTopicId], [
      "supergroup",
      400,
      7,
      null,
    ]);
    const f = await submitPost(deps, {
      title: "f",
      username: "alice",
      url: "https://t.me/myforum/9/9",
    });
    const forum = await getPost(db, f.id);
    assertEquals([forum?.postType, forum?.channelId, forum?.messageId, forum?.forumTopicId], [
      "forum",
      500,
      9,
      9,
    ]);
    const t = await submitPost(deps, {
      title: "t",
      username: "alice",
      url: "https://t.me/mygroup/3/3",
    });
    assertEquals(
      (await getPost(db, t.id))?.forumTopicId,
      null,
      "topic segment ignored for a non-forum peer",
    );
    assert(!fake.calls.some((c) => c.startsWith("getDiscussionThread")));
  });
});

Deno.test("submit errors", async () => {
  await withDb(async (db) => {
    const { deps, fake } = world(db);
    await expectHttp(
      submitPost(deps, { title: "x", username: "alice", url: "nope" }),
      400,
      "malformed_url",
    );
    await expectHttp(
      submitPost(deps, { title: "x", username: "bob", url: "https://t.me/mychannel/5" }),
      404,
      "user_not_found",
    );
    await expectHttp(
      submitPost(deps, { title: "x", username: "alice", url: "https://t.me/unknown/5" }),
      400,
      "channel_not_found",
    );
    await expectHttp(
      submitPost(deps, { title: "x", username: "alice", url: "https://t.me/lonely/5" }),
      400,
      "no_discussion_group",
    );
    await expectHttp(
      submitPost(deps, { title: "x", username: "alice", url: "https://t.me/mychannel/6" }),
      400,
      "message_not_found",
    );
    fake.failNext(new FloodWait(30));
    const flood = await expectHttp(
      submitPost(deps, { title: "x", username: "alice", url: "https://t.me/mychannel/5" }),
      500,
      "flood_wait",
    );
    assertEquals(flood.extra.retry_after, 30);
    fake.failNext(new SessionInvalid("revoked"));
    await expectHttp(
      submitPost(deps, { title: "x", username: "alice", url: "https://t.me/mychannel/5" }),
      500,
      "session_invalid",
    );
    fake.failNext(new Upstream("timeout"));
    const up = await expectHttp(
      submitPost(deps, { title: "x", username: "alice", url: "https://t.me/mychannel/5" }),
      502,
      "upstream_failure",
    );
    assertEquals(up.extra.upstream_error, "timeout");
    assertEquals(await getPost(db, "0199a000-0000-7000-8000-000000000001"), null);
  });
});

Deno.test("get and delete a post", async () => {
  await withDb(async (db) => {
    const { deps } = world(db);
    const { id } = await submitPost(deps, {
      title: "My post",
      username: "alice",
      url: "https://t.me/mychannel/5",
    });
    const view = await getPostView(deps, id);
    assertEquals(view, {
      status: 200,
      id,
      username: "alice",
      title: "My post",
      url: "https://t.me/mychannel/5",
      comments_synced_at: null,
      sync_error: null,
      comment_sync_enabled: true,
      created_at: view.created_at,
      deleted_at: null,
    });
    const del = await deletePost(deps, id);
    assertEquals(del, { status: 200, id, deleted_at: "2026-01-01T10:15:30.000Z" });
    const repeat = await deletePost(deps, id);
    assertEquals(repeat.deleted_at, del.deleted_at);
    const after = await getPostView(deps, id);
    assertEquals(after.deleted_at, del.deleted_at);
    assertEquals(after.comment_sync_enabled, false);
    await expectHttp(
      getPostView(deps, "0199a000-0000-7000-8000-000000000001"),
      404,
      "post_not_found",
    );
    await expectHttp(
      deletePost(deps, "0199a000-0000-7000-8000-000000000001"),
      404,
      "post_not_found",
    );
  });
});
