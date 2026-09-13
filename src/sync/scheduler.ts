import type { Deps } from "../deps.ts";
import { type PickedJob, pickJobs, releaseJob } from "./models/jobs.ts";
import { closeRun, openRun } from "./models/runs.ts";
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

  async function noRunner(job: PickedJob): Promise<void> {
    const error = `no runner for platform ${job.platform}`;
    const runId = await openRun(deps.db, {
      jobId: job.id,
      postId: job.postId,
      platform: job.platform,
      startedAt: deps.now(),
    });
    await closeRun(deps.db, runId, { finishedAt: deps.now(), status: "failure", error });
    await releaseJob(deps.db, job.id, job.leaseToken, { disable: false });
  }

  function launch(job: PickedJob): void {
    const runner = byPlatform.get(job.platform);
    const work =
      (runner === undefined
        ? noRunner(job)
        : runJob(deps, runner, job, options.leaseMs).then(() => undefined))
        .catch((e: unknown) => {
          console.error(`run for job ${job.id} crashed:`, e);
        });
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }

  async function tick(): Promise<void> {
    const room = options.concurrency - inFlight.size;
    if (room <= 0) return;
    const jobs = await pickJobs(deps.db, {
      batchSize: Math.min(options.batchSize, room),
      leaseMs: options.leaseMs,
    });
    for (const job of jobs) launch(job);
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
      if (timer !== null) clearInterval(timer);
      timer = null;
      await Promise.all([...inFlight]);
    },
  };
}
