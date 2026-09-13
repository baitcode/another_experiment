import type { Deps } from "../deps.ts";
import { fenceJob, heartbeatJob, type PickedJob, releaseJob } from "./models/jobs.ts";
import { closeRun, openRun } from "./models/runs.ts";
import { type Lease, LeaseLost, type PlatformSyncRunner, type RunOutcome } from "./runner.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runJob(
  deps: Deps,
  runner: PlatformSyncRunner,
  job: PickedJob,
  leaseMs: number,
): Promise<RunOutcome> {
  const runId = await openRun(deps.db, {
    jobId: job.id,
    postId: job.postId,
    platform: job.platform,
    startedAt: deps.now(),
  });

  const state = { lost: false, committed: false };
  const beat = setInterval(() => {
    heartbeatJob(deps.db, job.id, job.leaseToken, leaseMs)
      .then((ok) => {
        if (!ok) state.lost = true;
      })
      .catch((e: unknown) => {
        console.error(`heartbeat for job ${job.id} failed:`, e);
      });
  }, Math.max(1, Math.floor(leaseMs / 2)));

  const lease: Lease = {
    token: job.leaseToken,
    commit: (fn) =>
      deps.db.transaction(async (tx) => {
        const held = await fenceJob(tx, job.id, job.leaseToken);
        if (!held) throw new LeaseLost();
        const outcome = await fn(tx);
        await closeRun(tx, runId, {
          finishedAt: deps.now(),
          status: outcome.status,
          error: outcome.status === "failure" ? outcome.error : null,
        });
        await releaseJob(tx, job.id, job.leaseToken, {
          disable: outcome.status === "failure" && outcome.disable,
        });
        state.committed = true;
        return outcome;
      }),
  };

  try {
    return await runner.run(job, lease);
  } catch (e: unknown) {
    if (e instanceof LeaseLost || state.lost) {
      const outcome: RunOutcome = { status: "failure", error: "lease lost", disable: false };
      await closeRun(deps.db, runId, {
        finishedAt: deps.now(),
        status: "failure",
        error: "lease lost",
      });
      return outcome;
    }
    const outcome: RunOutcome = { status: "failure", error: errorMessage(e), disable: false };
    if (!state.committed) {
      try {
        await lease.commit(() => Promise.resolve(outcome));
      } catch (inner: unknown) {
        if (!(inner instanceof LeaseLost)) throw inner;
        await closeRun(deps.db, runId, {
          finishedAt: deps.now(),
          status: "failure",
          error: "lease lost",
        });
        return { status: "failure", error: "lease lost", disable: false };
      }
    }
    return outcome;
  } finally {
    clearInterval(beat);
  }
}
