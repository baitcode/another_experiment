import type { Tx } from "../db/client.ts";
import type { Infra } from "../deps.ts";
import type { PickedJob } from "./models/jobs.ts";

export type RunOutcome =
  | { status: "success" }
  | { status: "failure"; error: string; disable: boolean };

export class LeaseLost extends Error {
  constructor() {
    super("lease lost");
  }
}

export interface RunOptions {
  pageSize: number;
}

/** What a run writes: executed by the sync domain inside the run's one fenced transaction,
 *  after the job row has been re-taken under the lease token. */
export type RunWrite = (tx: Tx) => Promise<RunOutcome>;

/** One per platform, registered under its `Platform` key. Does the upstream work for one job
 *  (one page) and hands back the write to make. It never sees the lease: fencing, closing the
 *  run row and releasing are the sync domain's, see `wrapRunner`. */
export type PlatformSyncRunner = (
  infra: Infra,
  job: PickedJob,
  options: RunOptions,
) => Promise<RunWrite>;
