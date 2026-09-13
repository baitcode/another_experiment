import type { Infra } from "../deps.ts";
import { fenceJob, type PickedJob, releaseJob } from "./models/jobs.ts";
import { closeRun, openRun } from "./models/runs.ts";
import {
  LeaseLost,
  type PlatformSyncRunner,
  type RunOptions,
  type RunOutcome,
  type RunWrite,
} from "./runner.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function failing(error: string): RunWrite {
  return () => Promise.resolve({ status: "failure", error, disable: false });
}

/**
 * Wraps a platform runner in the lease protocol. The returned function is one run of a picked
 * job: open the run row, let the runner do its upstream work, then commit the write it handed
 * back in the one fenced transaction (re-take the job row under the token, write, close the run
 * row, release). A runner that throws is committed as a failure carrying its message; a write
 * that throws is rolled back and committed the same way. When the fence finds the lease taken by
 * another run, nothing is written and the run row is closed as `lease lost`.
 */
export function wrapRunner(
  deps: Infra,
  runner: PlatformSyncRunner,
  options: RunOptions,
): (job: PickedJob) => Promise<RunOutcome> {
  return async (job) => {
    const runId = await openRun(deps.db, {
      jobId: job.id,
      postId: job.postId,
      platform: job.platform,
      startedAt: deps.now(),
    });

    const commit = (write: RunWrite): Promise<RunOutcome> =>
      deps.db.transaction(async (tx) => {
        const held = await fenceJob(tx, job.id, job.leaseToken);
        if (!held) throw new LeaseLost();
        const outcome = await write(tx);
        await closeRun(tx, runId, {
          finishedAt: deps.now(),
          status: outcome.status,
          error: outcome.status === "failure" ? outcome.error : null,
        });
        await releaseJob(tx, job.id, job.leaseToken, {
          disable: outcome.status === "failure" && outcome.disable,
        });
        return outcome;
      });

    const closeLost = async (): Promise<RunOutcome> => {
      await closeRun(deps.db, runId, {
        finishedAt: deps.now(),
        status: "failure",
        error: "lease lost",
      });
      return { status: "failure", error: "lease lost", disable: false };
    };

    let write: RunWrite;
    try {
      write = await runner(deps, job, options);
    } catch (e: unknown) {
      write = failing(errorMessage(e));
    }

    try {
      return await commit(write);
    } catch (e: unknown) {
      if (e instanceof LeaseLost) return closeLost();
      // The write itself threw and was rolled back: commit its message as the outcome instead.
      try {
        return await commit(failing(errorMessage(e)));
      } catch (inner: unknown) {
        if (inner instanceof LeaseLost) return closeLost();
        throw inner;
      }
    }
  };
}
