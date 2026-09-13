import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const platforms = ["telegram"] as const;
export type Platform = (typeof platforms)[number];

export const postCommentsSyncJobs = pgTable(
  "post_comments_sync_jobs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    postId: uuid("post_id").notNull(),
    platform: text("platform").$type<Platform>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
  },
  (t) => [
    check("post_comments_sync_jobs_platform_check", sql`${t.platform} in ('telegram')`),
    uniqueIndex("post_comments_sync_jobs_platform_post_uniq").on(t.platform, t.postId),
    index("post_comments_sync_jobs_due_idx")
      .on(t.lockedAt.asc().nullsFirst())
      .where(sql`${t.isActive}`),
  ],
);

export const runStatuses = ["running", "success", "failure"] as const;
export type RunStatus = (typeof runStatuses)[number];

export const postCommentsSyncRuns = pgTable(
  "post_comments_sync_runs",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    postId: uuid("post_id").notNull(),
    platform: text("platform").$type<Platform>().notNull(),
    jobId: uuid("job_id").notNull().references(() => postCommentsSyncJobs.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").$type<RunStatus>().notNull().default("running"),
    error: text("error"),
  },
  (t) => [
    check("post_comments_sync_runs_platform_check", sql`${t.platform} in ('telegram')`),
    check(
      "post_comments_sync_runs_status_check",
      sql`${t.status} in ('running', 'success', 'failure')`,
    ),
    index("post_comments_sync_runs_post_idx").on(t.postId, t.startedAt.desc()),
  ],
);
