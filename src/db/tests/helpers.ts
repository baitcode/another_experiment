import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "../client.ts";
import { runMigrations } from "../migrate.ts";

const testUrl = Deno.env.get("TEST_DATABASE_URL") ??
  "postgres://postgres:postgres@localhost:5432/comments_test";

let ensured = false;

async function ensureDatabase(): Promise<void> {
  if (ensured) return;
  const url = new URL(testUrl);
  const dbName = url.pathname.slice(1);
  url.pathname = "/postgres";
  const admin = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (rows.length === 0) {
      await admin.unsafe(`create database "${dbName}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  ensured = true;
}

const tablesInDeleteOrder = [
  "post_comments_sync_runs",
  "post_comments_sync_jobs",
  "telegram_comments",
  "telegram_posts",
];

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql.raw(`truncate table ${tablesInDeleteOrder.join(", ")} cascade`));
}

export async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  await ensureDatabase();
  const handle = createDb(testUrl, { max: 5 });
  try {
    await runMigrations(handle.db);
    await resetDb(handle.db);
    await fn(handle.db);
  } finally {
    await handle.close();
  }
}
