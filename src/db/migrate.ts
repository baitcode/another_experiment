import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.ts";

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- node:url has no types in tsconfig.eslint.json (only @types/deno); fileURLToPath is the cross-platform file: URL -> path conversion
const migrationsFolder: string = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
