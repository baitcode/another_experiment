import { assertEquals } from "@std/assert";
import type { Infra } from "../../deps.ts";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import { ensureActiveJob } from "../models/jobs.ts";
import { listRunsForPost } from "../models/runs.ts";
import type { PlatformSyncRunner } from "../runner.ts";
import { createScheduler } from "../scheduler.ts";

const p = (n: number): string => `0199a000-0000-7000-8000-00000000000${String(n)}`;

function deps(db: Db): Infra {
  return {
    db,
    telegram: () => Promise.reject(new Error("no telegram in these tests")),
    now: () => new Date(),
  };
}

Deno.test("tick runs every picked job through its platform runner", async () => {
  await withDb(async (db) => {
    for (const n of [1, 2, 3]) await ensureActiveJob(db, { postId: p(n), platform: "telegram" });
    const seen: string[] = [];
    const runner: PlatformSyncRunner = (_infra, job) => {
      seen.push(job.postId);
      return Promise.resolve(() => Promise.resolve({ status: "success" }));
    };
    const s = createScheduler(deps(db), new Map([["telegram", runner]]), {
      tickMs: 10_000,
      batchSize: 2,
      leaseMs: 60_000,
      concurrency: 5,
      pageSize: 100,
    });
    await s.tick();
    await s.stop();
    assertEquals(seen.length, 2, "batch size caps a tick");
    await s.tick();
    await s.stop();
    // A released job is immediately due again (releaseJob always clears locked_until), so with
    // only 3 always-active jobs and a batch size of 2, the second tick's batch necessarily
    // reuses one job already run in the first tick alongside the one still-untouched job. Assert
    // the set of jobs seen rather than an exact, duplicate-free multiset.
    assertEquals([...new Set(seen)].sort(), [p(1), p(2), p(3)], "every job ran at least once");
  });
});

Deno.test("concurrency cap limits in-flight runs", async () => {
  await withDb(async (db) => {
    for (const n of [1, 2, 3]) await ensureActiveJob(db, { postId: p(n), platform: "telegram" });
    let inFlight = 0;
    let peak = 0;
    const runner: PlatformSyncRunner = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      return () => Promise.resolve({ status: "success" });
    };
    const s = createScheduler(deps(db), new Map([["telegram", runner]]), {
      tickMs: 10,
      batchSize: 10,
      leaseMs: 60_000,
      concurrency: 1,
      pageSize: 100,
    });
    s.start();
    await new Promise((r) => setTimeout(r, 400));
    await s.stop();
    assertEquals(peak, 1);
    for (const n of [1, 2, 3]) assertEquals((await listRunsForPost(db, p(n))).length >= 1, true);
  });
});

Deno.test("tick() is reentrant-safe: overlapping calls don't exceed the concurrency cap", async () => {
  await withDb(async (db) => {
    for (const n of [1, 2, 3]) await ensureActiveJob(db, { postId: p(n), platform: "telegram" });
    let inFlight = 0;
    let peak = 0;
    const runner: PlatformSyncRunner = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight--;
      return () => Promise.resolve({ status: "success" });
    };
    const s = createScheduler(deps(db), new Map([["telegram", runner]]), {
      tickMs: 10_000,
      batchSize: 10,
      leaseMs: 60_000,
      concurrency: 1,
      pageSize: 100,
    });
    await Promise.all([s.tick(), s.tick()]);
    await s.stop();
    assertEquals(peak, 1, "a second, overlapping tick must not double the room it computed");
  });
});

Deno.test("stop() during a mid-flight tick prevents it from launching runs", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId: p(1), platform: "telegram" });
    let calls = 0;
    const runner: PlatformSyncRunner = () => {
      calls++;
      return Promise.resolve(() => Promise.resolve({ status: "success" }));
    };
    const s = createScheduler(deps(db), new Map([["telegram", runner]]), {
      tickMs: 10_000,
      batchSize: 10,
      leaseMs: 60_000,
      concurrency: 5,
      pageSize: 100,
    });
    const tickPromise = s.tick();
    await s.stop();
    await tickPromise;
    assertEquals(calls, 0, "runner was never called");
    assertEquals(await listRunsForPost(db, p(1)), [], "no run row for the abandoned job");
  });
});

Deno.test("a job for a platform without a runner is failed and released", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId: p(1), platform: "telegram" });
    const s = createScheduler(deps(db), new Map(), {
      tickMs: 10_000,
      batchSize: 10,
      leaseMs: 60_000,
      concurrency: 5,
      pageSize: 100,
    });
    await s.tick();
    await s.stop();
    const [run] = await listRunsForPost(db, p(1));
    assertEquals(run?.status, "failure");
    assertEquals(run?.error, "no runner for platform telegram");
  });
});
