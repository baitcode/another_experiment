import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8000),
  JWT_SECRET: z.string().min(1),
  SYNC_TICK_MS: z.coerce.number().int().positive().default(1000),
  SYNC_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  SYNC_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  SYNC_CONCURRENCY: z.coerce.number().int().positive().default(10),
  SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  TELEGRAM_CLIENT: z.literal("fake").default("fake"),
});

export interface Config {
  databaseUrl: string;
  port: number;
  jwtSecret: string;
  sync: {
    tickMs: number;
    batchSize: number;
    leaseMs: number;
    concurrency: number;
    pageSize: number;
  };
  telegramClient: "fake";
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const e = schema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    jwtSecret: e.JWT_SECRET,
    sync: {
      tickMs: e.SYNC_TICK_MS,
      batchSize: e.SYNC_BATCH_SIZE,
      leaseMs: e.SYNC_LEASE_MS,
      concurrency: e.SYNC_CONCURRENCY,
      pageSize: e.SYNC_PAGE_SIZE,
    },
    telegramClient: e.TELEGRAM_CLIENT,
  };
}

export function loadConfigFromEnv(): Config {
  return loadConfig(Deno.env.toObject());
}
