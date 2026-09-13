import { assert, assertEquals } from "@std/assert";
import type { Hono } from "@hono/hono";
import { createApp } from "../../api/app.ts";
import { signToken } from "../../api/auth.ts";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import type { Infra } from "../../deps.ts";
import { createTelegramApi } from "../api/api.ts";
import { FakeTelegram } from "../client/fake.ts";
import { insertFromMessages } from "../models/comments.ts";

const SECRET = "s";
const CHAT = 200;
const ROOT = 50;

interface Json {
  status: number;
  [key: string]: unknown;
}

async function world(
  db: Db,
): Promise<{ app: Hono; fake: FakeTelegram; headers: Record<string, string> }> {
  const fake = new FakeTelegram();
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.linkDiscussion(100, 5, { chatId: CHAT, rootMessageId: ROOT });
  fake.addMessage(CHAT, ROOT, { id: 51, replyToMessageId: ROOT, text: "hi" });
  const deps: Infra = { db, telegram: (u) => fake.forUser(u), now: () => new Date() };
  const app = createApp({
    jwtSecret: SECRET,
    mounts: [{ path: "/telegram/v1", app: createTelegramApi(deps) }],
  });
  const token = await signToken(SECRET, "test");
  return {
    app,
    fake,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
}

async function call(
  app: Hono,
  headers: Record<string, string>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Json;
  return { status: res.status, json };
}

Deno.test("post lifecycle over HTTP", async () => {
  await withDb(async (db) => {
    const { app, headers } = await world(db);
    const created = await call(app, headers, "POST", "/telegram/v1/posts", {
      title: "My post",
      username: "alice",
      url: "https://t.me/mychannel/5",
    });
    assertEquals(created.status, 201);
    assertEquals(created.json.status, 201);
    const id = created.json.id as string;
    const again = await call(app, headers, "POST", "/telegram/v1/posts", {
      title: "My post",
      username: "alice",
      url: "https://t.me/mychannel/5",
    });
    assertEquals([again.status, again.json.status, again.json.id], [200, 200, id]);
    const got = await call(app, headers, "GET", `/telegram/v1/posts/${id}`);
    assertEquals(got.status, 200);
    assertEquals(got.json.comment_sync_enabled, true);
    const del = await call(app, headers, "DELETE", `/telegram/v1/posts/${id}`);
    assertEquals(del.status, 200);
    assert(typeof del.json.deleted_at === "string");
    const missing = await call(app, headers, "GET", "/telegram/v1/posts/not-a-uuid");
    assertEquals([missing.status, missing.json.code], [404, "post_not_found"]);
  });
});

Deno.test("request-shape errors", async () => {
  await withDb(async (db) => {
    const { app, headers } = await world(db);
    const bad = await call(app, headers, "POST", "/telegram/v1/posts", { title: "x" });
    assertEquals([bad.status, bad.json.code], [400, "malformed_body"]);
    const res = await app.request("/telegram/v1/posts", { method: "POST", headers, body: "{" });
    assertEquals(res.status, 400);
    assertEquals(((await res.json()) as Json).code, "malformed_body");
    const url = await call(app, headers, "POST", "/telegram/v1/posts", {
      title: "x",
      username: "alice",
      url: "https://t.me/mychannel/5?comment=1",
    });
    assertEquals([url.status, url.json.code], [400, "malformed_url"]);
    const noauth = await app.request("/telegram/v1/posts", { method: "POST" });
    assertEquals(noauth.status, 401);
  });
});

Deno.test("comments: list, reply, replies, paging query", async () => {
  await withDb(async (db) => {
    const { app, headers, fake } = await world(db);
    const created = await call(app, headers, "POST", "/telegram/v1/posts", {
      title: "My post",
      username: "alice",
      url: "https://t.me/mychannel/5",
    });
    const postId = created.json.id as string;
    const client = await fake.forUser("alice");
    await insertFromMessages(
      db,
      postId,
      (await client.getThreadMessages(CHAT, ROOT, 0, 100)).messages,
    );

    const list = await call(app, headers, "GET", `/telegram/v1/posts/${postId}/comments?limit=10`);
    assertEquals(list.status, 200);
    const items = list.json.items as { id: string; telegram_message_id: number }[];
    assertEquals(items.map((i) => i.telegram_message_id), [51]);
    assertEquals(list.json.next_cursor, null);
    const commentId = items[0]?.id ?? "";

    const badLimit = await call(
      app,
      headers,
      "GET",
      `/telegram/v1/posts/${postId}/comments?limit=0`,
    );
    assertEquals([badLimit.status, badLimit.json.code], [400, "malformed_query"]);
    const badCursor = await call(
      app,
      headers,
      "GET",
      `/telegram/v1/posts/${postId}/comments?cursor=zzz`,
    );
    assertEquals([badCursor.status, badCursor.json.code], [400, "malformed_cursor"]);

    const empty = await call(
      app,
      headers,
      "POST",
      `/telegram/v1/posts/${postId}/comments/${commentId}/reply`,
      { text: "" },
    );
    assertEquals([empty.status, empty.json.code], [400, "malformed_message"]);
    const reply = await call(
      app,
      headers,
      "POST",
      `/telegram/v1/posts/${postId}/comments/${commentId}/reply`,
      { text: "thanks" },
    );
    assertEquals([reply.status, reply.json.status], [201, 201]);
    assertEquals(reply.json.reply_to, commentId);
    assertEquals(reply.json.author_username, "alice");

    const replies = await call(
      app,
      headers,
      "GET",
      `/telegram/v1/posts/${postId}/comments/${commentId}/replies`,
    );
    assertEquals(replies.status, 200);
    assertEquals((replies.json.items as unknown[]).length, 1);

    const unknown = await call(
      app,
      headers,
      "GET",
      `/telegram/v1/posts/${postId}/comments/nope/replies`,
    );
    assertEquals([unknown.status, unknown.json.code], [404, "comment_not_found"]);
  });
});
