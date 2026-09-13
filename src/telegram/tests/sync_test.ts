import { assert, assertEquals } from "@std/assert";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import type { Deps } from "../../deps.ts";
import { getJobByPost, pickJobs } from "../../sync/models/jobs.ts";
import { listRunsForPost } from "../../sync/models/runs.ts";
import { runJob } from "../../sync/run.ts";
import { submitPost } from "../api/handlers/posts.ts";
import { listComments } from "../api/handlers/comments.ts";
import { FloodWait, SessionInvalid } from "../client/errors.ts";
import { FakeTelegram } from "../client/fake.ts";
import { getPost } from "../models/posts.ts";
import { createTelegramSyncRunner } from "../sync.ts";

const CHAT = 200;
const ROOT = 50;
const page = { limit: 100, after: null };

async function world(db: Db): Promise<{ deps: Deps; fake: FakeTelegram; postId: string }> {
  const fake = new FakeTelegram();
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.linkDiscussion(100, 5, { chatId: CHAT, rootMessageId: ROOT });
  const deps: Deps = { db, telegram: (u) => fake.forUser(u), now: () => new Date() };
  const { id } = await submitPost(deps, {
    title: "p",
    username: "alice",
    url: "https://t.me/mychannel/5",
  });
  return { deps, fake, postId: id };
}

async function runOnce(deps: Deps, pageSize = 100): Promise<void> {
  const [job] = await pickJobs(deps.db, { batchSize: 1, leaseMs: 60_000 });
  assert(job !== undefined, "a job was due");
  await runJob(deps, createTelegramSyncRunner(deps, { pageSize }), job, 60_000);
}

Deno.test("a run ingests one page, moves the mark, records success", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    for (let id = 51; id <= 53; id++) {
      fake.addMessage(CHAT, ROOT, { id, replyToMessageId: ROOT, text: `m${String(id)}` });
    }
    fake.addMessage(CHAT, ROOT, { id: 54, replyToMessageId: 51, text: "reply" });
    await runOnce(deps, 2);
    let post = await getPost(db, postId);
    assertEquals(post?.lastSyncedMessageId, 52);
    assert(post?.lastSyncedAt !== null);
    assertEquals(post?.syncError, null);
    assertEquals((await listComments(deps, { postId, page })).items.length, 2);
    await runOnce(deps, 2);
    post = await getPost(db, postId);
    assertEquals(post?.lastSyncedMessageId, 54);
    const top = (await listComments(deps, { postId, page })).items;
    assertEquals(top.map((c) => c.telegram_message_id), [51, 52, 53]);
    assertEquals(top[0]?.has_replies, true);
    await runOnce(deps, 2);
    assertEquals((await getPost(db, postId))?.lastSyncedMessageId, 54, "empty page keeps the mark");
    const runs = await listRunsForPost(db, postId);
    assertEquals(runs.map((r) => r.status), ["success", "success", "success"]);
    assertEquals(fake.calls.filter((c) => c.startsWith("getThreadMessages")).length, 3);
    assert(
      fake.calls.some((c) =>
        c.startsWith(`getThreadMessages(${String(CHAT)}, ${String(ROOT)}, 0, 2)`)
      ),
    );
  });
});

Deno.test("an ordinary failure is written to sync_error and the job stays active", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    fake.failNext(new FloodWait(30));
    await runOnce(deps);
    const post = await getPost(db, postId);
    assertEquals(post?.syncError, "flood_wait: FLOOD_WAIT_30");
    assertEquals(post?.lastSyncedAt, null);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, true);
    const [run] = await listRunsForPost(db, postId);
    assertEquals([run?.status, run?.error], ["failure", "flood_wait: FLOOD_WAIT_30"]);
    // the next run succeeds and clears the error
    await runOnce(deps);
    assertEquals((await getPost(db, postId))?.syncError, null);
  });
});

Deno.test("SessionInvalid and UserNotFound disable the job", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    fake.failNext(new SessionInvalid("AUTH_KEY_UNREGISTERED"));
    await runOnce(deps);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, false);
    assertEquals((await getPost(db, postId))?.syncError, "session_invalid: AUTH_KEY_UNREGISTERED");
    const second = await submitPost(deps, {
      title: "p",
      username: "alice",
      url: "https://t.me/mychannel/5",
    });
    assertEquals(second.status, 200);
    assertEquals(
      (await getJobByPost(db, { postId, platform: "telegram" }))?.isActive,
      true,
      "resubmit re-enables",
    );
    fake.accounts.delete("alice");
    await runOnce(deps);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, false);
    assertEquals((await getPost(db, postId))?.syncError, "user_not_found: user alice not found");
  });
});

Deno.test("a missing thread root fails the run without disabling", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    fake.threads.clear();
    await runOnce(deps);
    assertEquals((await getPost(db, postId))?.syncError?.startsWith("message_not_found"), true);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, true);
  });
});
