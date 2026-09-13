import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client.ts";

// Equivalent to node:url's fileURLToPath for this always-local, ASCII-safe
// path: node:url has no ambient types in this project's eslint TS project
// (only "@types/deno" is registered), so importing it makes every use of
// `fileURLToPath` an "error typed value" under typescript-eslint's
// no-unsafe-* rules with no clean fix short of eslint-disable or adding a
// new type dependency, both disallowed. decodeURIComponent + URL#pathname
// gives the same absolute filesystem path without that problem.
const migrationsFolder = decodeURIComponent(
  new URL("../../drizzle", import.meta.url).pathname,
);

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
