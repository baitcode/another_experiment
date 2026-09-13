import { and, eq, sql } from "drizzle-orm";
import type { Executor, Tx } from "../../db/client.ts";
import { type Platform, postCommentsSyncJobs } from "./schema.ts";

export interface JobKey {
  postId: string;
  platform: Platform;
}

export interface PickedJob {
  id: string;
  postId: string;
  platform: Platform;
  leaseToken: string;
}

export async function ensureActiveJob(ex: Executor, key: JobKey): Promise<void> {
  await ex
    .insert(postCommentsSyncJobs)
    .values({ postId: key.postId, platform: key.platform, isActive: true })
    .onConflictDoUpdate({
      target: [postCommentsSyncJobs.platform, postCommentsSyncJobs.postId],
      set: { isActive: true },
    });
}

export async function setJobActive(ex: Executor, key: JobKey, active: boolean): Promise<void> {
  await ex
    .update(postCommentsSyncJobs)
    .set({ isActive: active })
    .where(
      and(
        eq(postCommentsSyncJobs.postId, key.postId),
        eq(postCommentsSyncJobs.platform, key.platform),
      ),
    );
}

export async function getJobByPost(
  ex: Executor,
  key: JobKey,
): Promise<{ id: string; isActive: boolean } | null> {
  const rows = await ex
    .select({ id: postCommentsSyncJobs.id, isActive: postCommentsSyncJobs.isActive })
    .from(postCommentsSyncJobs)
    .where(
      and(
        eq(postCommentsSyncJobs.postId, key.postId),
        eq(postCommentsSyncJobs.platform, key.platform),
      ),
    );
  return rows[0] ?? null;
}

interface PickedRow extends Record<string, unknown> {
  id: string;
  post_id: string;
  platform: Platform;
  lease_token: string;
}

/** The pick statement from the spec: lease a batch of due jobs, least recently locked first. */
export async function pickJobs(
  ex: Executor,
  options: { batchSize: number; leaseMs: number },
): Promise<PickedJob[]> {
  const interval = sql`make_interval(secs => ${options.leaseMs}::numeric / 1000.0)`;
  const rows = await ex.execute<PickedRow>(sql`
    update post_comments_sync_jobs j
      set locked_at = now(),
          locked_until = now() + ${interval},
          lease_token = uuidv7()
    where j.id in (
      select id from post_comments_sync_jobs
      where is_active and (locked_until is null or locked_until < now())
      order by locked_at asc nulls first
      limit ${options.batchSize}
      for update skip locked
    )
    returning j.id, j.post_id, j.platform, j.lease_token
  `);
  return [...rows].map((r) => ({
    id: r.id,
    postId: r.post_id,
    platform: r.platform,
    leaseToken: r.lease_token,
  }));
}

export async function heartbeatJob(
  ex: Executor,
  jobId: string,
  leaseToken: string,
  leaseMs: number,
): Promise<boolean> {
  const rows = await ex
    .update(postCommentsSyncJobs)
    .set({ lockedUntil: sql`now() + make_interval(secs => ${leaseMs}::numeric / 1000.0)` })
    .where(
      and(eq(postCommentsSyncJobs.id, jobId), eq(postCommentsSyncJobs.leaseToken, leaseToken)),
    )
    .returning({ id: postCommentsSyncJobs.id });
  return rows.length > 0;
}

/** First statement of every run transaction: re-take the job row under the token. */
export async function fenceJob(tx: Tx, jobId: string, leaseToken: string): Promise<boolean> {
  const rows = await tx
    .select({ id: postCommentsSyncJobs.id })
    .from(postCommentsSyncJobs)
    .where(
      and(eq(postCommentsSyncJobs.id, jobId), eq(postCommentsSyncJobs.leaseToken, leaseToken)),
    )
    .for("update");
  return rows.length > 0;
}

export async function releaseJob(
  ex: Executor,
  jobId: string,
  leaseToken: string,
  options: { disable: boolean },
): Promise<void> {
  await ex
    .update(postCommentsSyncJobs)
    .set({
      lockedUntil: null,
      ...(options.disable ? { isActive: false } : {}),
    })
    .where(
      and(eq(postCommentsSyncJobs.id, jobId), eq(postCommentsSyncJobs.leaseToken, leaseToken)),
    );
}
