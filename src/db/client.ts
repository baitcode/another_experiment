import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export type Db = PostgresJsDatabase;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => undefined });
  const db = drizzle({ client });
  return {
    db,
    close: () => client.end({ timeout: 5 }),
  };
}
