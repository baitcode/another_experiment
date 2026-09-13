import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "../config.ts";

const base = {
  DATABASE_URL: "postgres://u:p@h:5432/d",
  JWT_SECRET: "secret",
};

Deno.test("loadConfig applies defaults", () => {
  const c = loadConfig(base);
  assertEquals(c.port, 8000);
  assertEquals(c.sync.tickMs, 1000);
  assertEquals(c.sync.batchSize, 10);
  assertEquals(c.sync.leaseMs, 30_000);
  assertEquals(c.sync.concurrency, 10);
  assertEquals(c.sync.pageSize, 100);
  assertEquals(c.telegramClient, "fake");
});

Deno.test("loadConfig reads overrides", () => {
  const c = loadConfig({ ...base, PORT: "9000", SYNC_BATCH_SIZE: "3" });
  assertEquals(c.port, 9000);
  assertEquals(c.sync.batchSize, 3);
});

Deno.test("loadConfig rejects a missing DATABASE_URL", () => {
  assertThrows(() => loadConfig({ JWT_SECRET: "s" }));
});
