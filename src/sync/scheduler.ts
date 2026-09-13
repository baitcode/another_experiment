import type { Deps } from "../deps.ts";
import { type PickedJob, pickJobs } from "./models/jobs.ts";
import { runJob } from "./run.ts";
import type { PlatformSyncRunner } from "./runner.ts";
import type { Platform } from "./models/schema.ts";

export interface SchedulerOptions {
  tickMs: number;
  batchSize: number;
  leaseMs: number;
  concurrency: number;
}

export interface Scheduler {
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createScheduler(
  deps: Deps,
  runners: PlatformSyncRunner[],
  options: SchedulerOptions,
): Scheduler {
  const byPlatform = new Map<Platform, PlatformSyncRunner>(runners.map((r) => [r.platform, r]));
  const inFlight = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  // Bumped by stop(). A tick captures the epoch it started with and, after the `await
  // pickJobs(...)` below, checks it's still current: a stop() that raced this specific call (i.e.
  // ran while it was suspended) bumps the epoch and the tick aborts instead of launching runs
  // against a pool the caller may be closing right after stop() returns. A stop() that already
  // fully completed before this tick started does not affect it (its epoch is already current).
  let epoch = 0;

  function launch(job: PickedJob): void {
    // A job whose platform has no registered runner still goes through the fenced `runJob`
    // path (via an inline runner that immediately fails), so it's closed and released under
    // the same fence as any other run instead of three unfenced statements.
    const fallback: PlatformSyncRunner = {
      platform: job.platform,
      run: (_job, lease) =>
        lease.commit(() =>
          Promise.resolve({
            status: "failure",
            error: `no runner for platform ${job.platform}`,
            disable: false,
          })
        ),
    };
    const runner = byPlatform.get(job.platform) ?? fallback;
    const work = runJob(deps, runner, job, options.leaseMs)
      .then(() => undefined)
      .catch((e: unknown) => {
        console.error(`run for job ${job.id} crashed:`, e);
      });
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }

  async function tick(): Promise<void> {
    // Reentrancy guard: `room` is computed from a snapshot of `inFlight.size` and only becomes
    // stale across an `await`, so overlapping ticks (e.g. a slow pickJobs racing the interval)
    // must not both compute room from the same stale snapshot and together exceed concurrency.
    if (ticking) return;
    ticking = true;
    const myEpoch = epoch;
    try {
      const room = options.concurrency - inFlight.size;
      if (room <= 0) return;
      const jobs = await pickJobs(deps.db, {
        batchSize: Math.min(options.batchSize, room),
        leaseMs: options.leaseMs,
      });
      // If stop() ran while we were suspended above, the leases we just took will simply expire;
      // launching runs now would race the pool the caller may close right after stop() returns.
      if (epoch !== myEpoch) return;
      for (const job of jobs) launch(job);
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        tick().catch((e: unknown) => {
          console.error("scheduler tick failed:", e);
        });
      }, options.tickMs);
    },
    async stop() {
      epoch++;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await Promise.all([...inFlight]);
    },
  };
}
