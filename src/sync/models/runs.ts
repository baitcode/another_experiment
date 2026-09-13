import { desc, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { type Platform, postCommentsSyncRuns } from "./schema.ts";

export type RunRow = typeof postCommentsSyncRuns.$inferSelect;

export async function openRun(
  ex: Executor,
  input: { jobId: string; postId: string; platform: Platform; startedAt: Date },
): Promise<string> {
  const rows = await ex
    .insert(postCommentsSyncRuns)
    .values({ ...input, status: "running" })
    .returning({ id: postCommentsSyncRuns.id });
  const row = rows[0];
  if (row === undefined) throw new Error("openRun returned no row");
  return row.id;
}

export async function closeRun(
  ex: Executor,
  runId: string,
  input: { finishedAt: Date; status: "success" | "failure"; error: string | null },
): Promise<void> {
  await ex
    .update(postCommentsSyncRuns)
    .set({ finishedAt: input.finishedAt, status: input.status, error: input.error })
    .where(eq(postCommentsSyncRuns.id, runId));
}

export function listRunsForPost(ex: Executor, postId: string): Promise<RunRow[]> {
  return ex
    .select()
    .from(postCommentsSyncRuns)
    .where(eq(postCommentsSyncRuns.postId, postId))
    .orderBy(desc(postCommentsSyncRuns.startedAt));
}
