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

  const state = {
    lost: false,
    committed: false,
    commitInFlight: false,
    heartbeat: null as Promise<void> | null,
  };
  const beat = setInterval(() => {
    const inFlight = heartbeatJob(deps.db, job.id, job.leaseToken, leaseMs)
      .then((ok) => {
        if (!ok) state.lost = true;
      })
      .catch((e: unknown) => {
        console.error(`heartbeat for job ${job.id} failed:`, e);
      });
    state.heartbeat = inFlight;
    void inFlight.finally(() => {
      if (state.heartbeat === inFlight) state.heartbeat = null;
    });
  }, Math.max(1, Math.floor(leaseMs / 2)));

  const lease: Lease = {
    token: job.leaseToken,
    commit: async (fn) => {
      // A commit already succeeded, or one is currently running: either way, a second call is
      // a runner bug. A commit that *failed* (fn threw, or the fence found the lease lost)
      // clears commitInFlight in the `finally` below without ever setting `committed`, so
      // runJob's own single fallback commit (for a runner that threw without ever committing,
      // or whose one attempt just failed) is still allowed through.
      if (state.committed || state.commitInFlight) {
        throw new Error("lease.commit called twice");
      }
      state.commitInFlight = true;
      try {
        // Stop the heartbeat and let any already in-flight one finish *before* we take the
        // fenced row lock: otherwise a heartbeat UPDATE can sit blocked on that lock and fire
        // right after we commit and release, resurrecting locked_until with the (still valid,
        // unrotated) lease token.
        clearInterval(beat);
        if (state.heartbeat !== null) {
          await state.heartbeat;
        }
        return await deps.db.transaction(async (tx) => {
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
        });
      } finally {
        state.commitInFlight = false;
      }
    },
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
