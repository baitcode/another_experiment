import { Command } from "@cliffy/command";
import { createApp } from "./api/app.ts";
import { type Config, loadConfigFromEnv } from "./config.ts";
import { createDb, type DbHandle } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import type { Deps } from "./deps.ts";
import { createScheduler, type Scheduler } from "./sync/scheduler.ts";
import { createTelegramApi } from "./telegram/api/api.ts";
import type { TelegramFactory } from "./telegram/client/client.ts";
import { FakeTelegram, seedDemo } from "./telegram/client/fake.ts";
import { createTelegramSyncRunner } from "./telegram/sync.ts";

// `Config.telegramClient` is a single-member literal type ("fake") until a second binding
// exists, so there is nothing to branch on yet.
function telegramFactory(): TelegramFactory {
  const fake = new FakeTelegram();
  seedDemo(fake);
  return (username) => fake.forUser(username);
}

function buildDeps(config: Config): { deps: Deps; handle: DbHandle } {
  const handle = createDb(config.databaseUrl);
  const deps: Deps = { db: handle.db, telegram: telegramFactory(), now: () => new Date() };
  return { deps, handle };
}

function startScheduler(deps: Deps, config: Config): Scheduler {
  const scheduler = createScheduler(
    deps,
    [createTelegramSyncRunner(deps, { pageSize: config.sync.pageSize })],
    config.sync,
  );
  scheduler.start();
  console.log(
    `sync: tick ${String(config.sync.tickMs)}ms, batch ${String(config.sync.batchSize)}, lease ${
      String(config.sync.leaseMs)
    }ms, concurrency ${String(config.sync.concurrency)}`,
  );
  return scheduler;
}

async function waitForSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
      resolve();
    };
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
  });
}

const serve = new Command()
  .description("Run the HTTP API")
  .option("--with-sync", "Also run the comment sync scheduler in this process")
  .action(async ({ withSync }) => {
    const config = loadConfigFromEnv();
    const { deps, handle } = buildDeps(config);
    const app = createApp({
      jwtSecret: config.jwtSecret,
      mounts: [{ path: "/telegram/v1", app: createTelegramApi(deps) }],
    });
    const server = Deno.serve({ port: config.port }, app.fetch);
    console.log(`http: listening on :${String(config.port)}`);
    const scheduler = withSync === true ? startScheduler(deps, config) : null;
    await waitForSignal();
    await server.shutdown();
    if (scheduler !== null) await scheduler.stop();
    await handle.close();
  });

const sync = new Command()
  .description("Run the comment sync scheduler alone")
  .action(async () => {
    const config = loadConfigFromEnv();
    const { deps, handle } = buildDeps(config);
    const scheduler = startScheduler(deps, config);
    await waitForSignal();
    await scheduler.stop();
    await handle.close();
  });

const migrate = new Command()
  .description("Apply pending database migrations")
  .action(async () => {
    const config = loadConfigFromEnv();
    const handle = createDb(config.databaseUrl, { max: 1 });
    try {
      await runMigrations(handle.db);
      console.log("migrate: up to date");
    } finally {
      await handle.close();
    }
  });

await new Command()
  .name("comments")
  .description("Telegram comment service: API, sync scheduler and migrations")
  .command("serve", serve)
  .command("sync", sync)
  .command("migrate", migrate)
  .parse(Deno.args);
