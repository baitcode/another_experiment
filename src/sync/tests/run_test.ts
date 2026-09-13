import { assert, assertEquals } from "@std/assert";
import type { Infra } from "../../deps.ts";
import { withDb } from "../../db/tests/helpers.ts";
import { ensureActiveJob, getJobByPost, pickJobs } from "../models/jobs.ts";
import { listRunsForPost } from "../models/runs.ts";
import { wrapRunner } from "../run.ts";
import type { PlatformSyncRunner } from "../runner.ts";
import type { Db } from "../../db/client.ts";

const postId = "0199a000-0000-7000-8000-000000000001";
const options = { pageSize: 100 };

function deps(db: Db): Infra {
  return {
    db,
    telegram: () => Promise.reject(new Error("no telegram in these tests")),
    now: () => new Date(),
  };
}

Deno.test("a successful run closes the run row and releases the lease", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = () =>
      Promise.resolve(() => Promise.resolve({ status: "success" }));
    const outcome = await wrapRunner(deps(db), runner, options)(job);
    assertEquals(outcome, { status: "success" });
    const [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "success");
    const again = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(again.length, 1, "lease was released");
  });
});

Deno.test("the runner receives the infra, the job and the options", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const infra = deps(db);
    let seen: unknown[] = [];
    const runner: PlatformSyncRunner = (i, j, o) => {
      seen = [i, j, o];
      return Promise.resolve(() => Promise.resolve({ status: "success" }));
    };
    await wrapRunner(infra, runner, { pageSize: 7 })(job);
    assertEquals(seen, [infra, job, { pageSize: 7 }]);
  });
});

Deno.test("a failure with disable closes the run as failure and disables the job", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = () =>
      Promise.resolve(() =>
        Promise.resolve({ status: "failure", error: "session_invalid: revoked", disable: true })
      );
    await wrapRunner(deps(db), runner, options)(job);
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
    const runner: PlatformSyncRunner = () => Promise.reject(new Error("bug"));
    const outcome = await wrapRunner(deps(db), runner, options)(job);
    assertEquals(outcome, { status: "failure", error: "bug", disable: false });
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
    const runner: PlatformSyncRunner = () =>
      Promise.resolve(() => {
        wroteInside = true;
        return Promise.resolve({ status: "success" });
      });
    const outcome = await wrapRunner(deps(db), runner, options)(job);
    assertEquals(outcome, { status: "failure", error: "lease lost", disable: false });
    assertEquals(wroteInside, false);
    const runs = await listRunsForPost(db, postId);
    assertEquals(runs[0]?.error, "lease lost");
    const held = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(held.length, 0, "the new holder's lease is untouched");
  });
});

Deno.test("a write that throws is rolled back and the run is closed as failure with its message", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = () =>
      Promise.resolve(() => {
        throw new Error("boom inside write");
      });
    const outcome = await wrapRunner(deps(db), runner, options)(job);
    assertEquals(outcome, { status: "failure", error: "boom inside write", disable: false });
    const runs = await listRunsForPost(db, postId);
    assertEquals(runs.length, 1, "the rolled-back attempt did not leave the run row open");
    assertEquals(runs[0]?.status, "failure");
    assertEquals(runs[0]?.error, "boom inside write");
    const again = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(again.length, 1, "lease was released");
  });
});
