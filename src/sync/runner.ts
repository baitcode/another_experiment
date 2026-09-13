import type { Tx } from "../db/client.ts";
import type { PickedJob } from "./models/jobs.ts";
import type { Platform } from "./models/schema.ts";

export type RunOutcome =
  | { status: "success" }
  | { status: "failure"; error: string; disable: boolean };

export class LeaseLost extends Error {
  constructor() {
    super("lease lost");
  }
}

export interface Lease {
  readonly token: string;
  /** The run's one fenced transaction: re-takes the job row, runs `fn`, closes the run row
   *  and releases the lease, then commits. Rejects with LeaseLost (nothing written) when the
   *  token no longer matches. A runner calls it exactly once, as its last act. */
  commit(fn: (tx: Tx) => Promise<RunOutcome>): Promise<RunOutcome>;
}

/** One per platform. Fetches one page for the job and writes it inside `lease.commit`. */
export interface PlatformSyncRunner {
  readonly platform: Platform;
  run(job: PickedJob, lease: Lease): Promise<RunOutcome>;
}
