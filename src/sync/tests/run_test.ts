import { assert, assertEquals } from "@std/assert";
import type { Deps } from "../../deps.ts";
import { withDb } from "../../db/tests/helpers.ts";
import { UserNotFound } from "../../telegram/client/errors.ts";
import { ensureActiveJob, getJobByPost, pickJobs } from "../models/jobs.ts";
import { listRunsForPost } from "../models/runs.ts";
import { runJob } from "../run.ts";
import type { PlatformSyncRunner } from "../runner.ts";
import type { Db } from "../../db/client.ts";

const postId = "0199a000-0000-7000-8000-000000000001";

function deps(db: Db): Deps {
  return { db, telegram: () => Promise.reject(new UserNotFound("x")), now: () => new Date() };
}

Deno.test("a successful run closes the run row and releases the lease", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: (_job, lease) => lease.commit(() => Promise.resolve({ status: "success" })),
    };
    const outcome = await runJob(deps(db), runner, job, 60_000);
    assertEquals(outcome, { status: "success" });
    const [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "success");
    const again = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(again.length, 1, "lease was released");
  });
});

Deno.test("a failure with disable closes the run as failure and disables the job", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: (_job, lease) =>
        lease.commit(() =>
          Promise.resolve({ status: "failure", error: "session_invalid: revoked", disable: true })
        ),
    };
    await runJob(deps(db), runner, job, 60_000);
    const [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "failure");
    assertEquals(run?.error, "session_invalid: revoked");
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, false);
  });
});

Deno.test("a runner that throws closes the run as failure and releases", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: () => Promise.reject(new Error("bug")),
    };
    const outcome = await runJob(deps(db), runner, job, 60_000);
    assertEquals(outcome.status, "failure");
    const [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "failure");
    assertEquals(run?.error, "bug");
    assertEquals((await pickJobs(db, { batchSize: 1, leaseMs: 60_000 })).length, 1);
  });
});

Deno.test("a lost lease rolls back and closes the run as 'lease lost'", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 1 });
    assert(job !== undefined);
    await new Promise((r) => setTimeout(r, 20));
    const [stolen] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(stolen !== undefined && stolen.leaseToken !== job.leaseToken);
    let wroteInside = false;
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: (_job, lease) =>
        lease.commit(() => {
          wroteInside = true;
          return Promise.resolve({ status: "success" });
        }),
    };
    const outcome = await runJob(deps(db), runner, job, 60_000);
    assertEquals(outcome, { status: "failure", error: "lease lost", disable: false });
    assertEquals(wroteInside, false);
    const runs = await listRunsForPost(db, postId);
    assertEquals(runs[0]?.error, "lease lost");
    const held = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(held.length, 0, "the new holder's lease is untouched");
  });
});

Deno.test("heartbeat keeps a long call from being picked twice", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 200 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: async (_job, lease) => {
        await new Promise((r) => setTimeout(r, 450));
        return lease.commit(() => Promise.resolve({ status: "success" }));
      },
    };
    const running = runJob(deps(db), runner, job, 200);
    await new Promise((r) => setTimeout(r, 300));
    assertEquals((await pickJobs(db, { batchSize: 1, leaseMs: 200 })).length, 0, "still leased");
    assertEquals(await running, { status: "success" });
  });
});
