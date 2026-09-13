import { assert, assertEquals } from "@std/assert";
import { withDb } from "../../db/tests/helpers.ts";
import { ensureActiveJob, getJobByPost } from "../models/jobs.ts";
import { closeRun, listRunsForPost, openRun } from "../models/runs.ts";

const postId = "0199a000-0000-7000-8000-000000000001";

Deno.test("a run opens as running and closes once", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const job = await getJobByPost(db, { postId, platform: "telegram" });
    assert(job !== null);
    const started = new Date("2026-01-01T10:00:00Z");
    const runId = await openRun(db, {
      jobId: job.id,
      postId,
      platform: "telegram",
      startedAt: started,
    });
    let [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "running");
    assertEquals(run?.finishedAt, null);
    await closeRun(db, runId, {
      finishedAt: new Date("2026-01-01T10:00:01Z"),
      status: "failure",
      error: "boom",
    });
    [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "failure");
    assertEquals(run?.error, "boom");
    assertEquals(run?.finishedAt?.toISOString(), "2026-01-01T10:00:01.000Z");
  });
});
