import { assert, assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { withDb } from "../../db/tests/helpers.ts";
import {
  ensureActiveJob,
  fenceJob,
  getJobByPost,
  pickJobs,
  releaseJob,
  setJobActive,
} from "../models/jobs.ts";

const p = (n: number): string => `0199a000-0000-7000-8000-00000000000${String(n)}`;

Deno.test("ensureActiveJob inserts once and re-enables", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId: p(1), platform: "telegram" });
    await setJobActive(db, { postId: p(1), platform: "telegram" }, false);
    assertEquals((await getJobByPost(db, { postId: p(1), platform: "telegram" }))?.isActive, false);
    await ensureActiveJob(db, { postId: p(1), platform: "telegram" });
    assertEquals((await getJobByPost(db, { postId: p(1), platform: "telegram" }))?.isActive, true);
    const rows = await db.execute(sql`select count(*)::int as n from post_comments_sync_jobs`);
    assertEquals(rows[0]?.n, 1);
  });
});

Deno.test("pickJobs leases never-locked jobs first, then least recently locked", async () => {
  await withDb(async (db) => {
    for (const n of [1, 2, 3]) await ensureActiveJob(db, { postId: p(n), platform: "telegram" });
    const first = await pickJobs(db, { batchSize: 2, leaseMs: 60_000 });
    assertEquals(first.length, 2);
    for (const j of first) assert(j.leaseToken.length === 36);
    const second = await pickJobs(db, { batchSize: 2, leaseMs: 60_000 });
    assertEquals(second.map((j) => j.postId), [p(3)], "leased jobs are skipped");
    for (const j of [...first, ...second]) {
      await releaseJob(db, j.id, j.leaseToken, { disable: false });
    }
    const third = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(third.length, 1);
    assert(
      [first[0]?.postId, first[1]?.postId].includes(third[0]?.postId),
      "round-robin by locked_at",
    );
  });
});

Deno.test("pickJobs skips inactive jobs and re-takes expired leases", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId: p(1), platform: "telegram" });
    await ensureActiveJob(db, { postId: p(2), platform: "telegram" });
    await setJobActive(db, { postId: p(2), platform: "telegram" }, false);
    const [job] = await pickJobs(db, { batchSize: 10, leaseMs: 1 });
    assert(job !== undefined);
    assertEquals(job.postId, p(1));
    await new Promise((r) => setTimeout(r, 20));
    const again = await pickJobs(db, { batchSize: 10, leaseMs: 60_000 });
    assertEquals(again.map((j) => j.postId), [p(1)]);
    assert(again[0]?.leaseToken !== job.leaseToken, "a new pick issues a new token");
  });
});

Deno.test("fence and release honour the lease token", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId: p(1), platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    await db.transaction(async (tx) => {
      assertEquals(await fenceJob(tx, job.id, job.leaseToken), true);
      assertEquals(await fenceJob(tx, job.id, p(9)), false);
    });
    await releaseJob(db, job.id, p(9), { disable: true });
    assertEquals((await getJobByPost(db, { postId: p(1), platform: "telegram" }))?.isActive, true);
    await releaseJob(db, job.id, job.leaseToken, { disable: true });
    assertEquals((await getJobByPost(db, { postId: p(1), platform: "telegram" }))?.isActive, false);
    const rows = await db.execute(sql`select locked_until from post_comments_sync_jobs`);
    assertEquals(rows[0]?.locked_until, null);
  });
});
