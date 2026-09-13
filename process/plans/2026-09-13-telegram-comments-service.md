# Telegram Comment Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Telegram comment service described in `process/spec.md`: submit/get/delete posts, list comments and replies, reply to a comment, and a leased scheduler that syncs comment threads one page per run.

**Architecture:** One Deno 2 binary with three Cliffy commands (`serve`, `sync`, `migrate`). A platform-agnostic `api/` (Hono root, auth, errors, cursor paging) and `sync/` (lease, runs, scheduler) never import `telegram/`; `telegram/` holds the platform's models, client interface, fake client, sync runner and HTTP handlers; `cli.ts` wires them together. The Telegram MTProto library is an external service and only its interface exists here; a fake in-memory implementation is used in tests and in the local environment.

**Tech Stack:** Deno 2.9, Hono 4.13 (jsr), zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, postgres.js 3.4, PostgreSQL 18, Cliffy 1.2, ESLint 10 + typescript-eslint 8 (type-aware), `deno fmt`, `@std/assert`.

**Spec:** `process/spec.md` (business rules) and `process/constitution.md` (code conventions). Read both before any task.

## Global Constraints

Copied from `process/constitution.md`; every task implicitly includes them.

- Runtime is Deno 2; no build step. Dependencies are declared in `deno.json` `imports` with exact versions (see Task 1), never inline `npm:`/`jsr:` specifiers in source.
- Database is PostgreSQL 18+; every id is `uuid primary key default uuidv7()` assigned by the database.
- `api/` and `sync/` never import `telegram/`. `telegram/models/` imports only `db/`. `telegram/sync.ts` imports models and client only. `telegram/client/` imports nothing from the service. `src/cli.ts` is the sole place that wires platform apps and runners.
- Every SQL statement for a table lives in that table's file under `models/`. Handlers and runners compose model calls.
- Handlers are functions `(deps, input) -> result | throw`; `api.ts` parses the request, calls the handler, serialises.
- Library errors carry a `kind`; each context (submit, reply, sync) maps them in one exhaustive `switch`. Nothing string-matches an error message.
- `Deps` is built in `cli.ts` and passed down; tests pass the fake client and a real database.
- Tables are declared in `models/schema.ts` files; `deno task db:generate` produces the migration; generated SQL under `drizzle/` is reviewed and committed, never hand-formatted.
- Tests live in each module's `tests/` folder, named `*_test.ts`, and run against PostgreSQL 18.
- **After any edit: run `deno fmt`, then `deno task check`, then `deno task test`, in that order, and fix what they report before committing.** A task is not done until all three pass.
- ESLint: `strictTypeChecked` + `stylisticTypeChecked`, type-aware; these are never disabled: `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `no-explicit-any`, `no-unsafe-*`, `no-non-null-assertion`, `strict-boolean-expressions`. An inline `eslint-disable` needs a reason on the same line.
- `deno fmt` settings: lineWidth 100, indentWidth 2, no tabs, double quotes, semicolons, proseWrap preserve.
- Commit messages carry no co-author footer (user rule).

## Toolchain facts established by a spike (do not re-derive)

- Deno 2.9.6 ships TypeScript 6. Deno now auto-reads a root `tsconfig.json`, so the ESLint tsconfig is named **`tsconfig.eslint.json`** and referenced via `parserOptions.project` (not `projectService`). This is a deliberate deviation from the constitution's `tsconfig.json` name and is recorded in README.
- npm packages resolve for ESLint through `node_modules` (`"nodeModulesDir": "auto"` + `deno install`). jsr packages do not land in `node_modules`; `"vendor": true` puts them under `vendor/jsr.io/<scope>/<name>/<version>/`, and `tsconfig.eslint.json` maps each jsr import to its vendored entry file. **Versions are therefore pinned exactly in `deno.json` and repeated in the tsconfig paths**; bumping one means editing both.
- Vendored jsr files keep `jsr:` specifiers for their own dependencies. If ESLint reports `no-unsafe-*` on a value whose type comes from such a transitive import (seen only as a risk for Cliffy), add a `paths` entry for that exact `jsr:` specifier pointing at its vendored file. Do not disable the rule.
- `@hono/zod-validator` does not type-check under this setup (its `npm:zod` imports are unresolvable). Validation is done directly with `zod` in `api.ts` (`schema.safeParse`). Deviation recorded in README.
- Deno's minimum-dependency-age policy rejects versions published in the last 24h; the versions in Task 1 are old enough.
- `deno run -A npm:drizzle-kit generate` works under Deno with the `drizzle.config.ts` in Task 2.
- Deno on the host lives at `~/.deno/bin/deno`; the executing shell must have `export PATH=$HOME/.deno/bin:$PATH`.
- Tests need a PostgreSQL 18 at `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/comments_test`). Start it with `docker compose up -d db` (Task 2 adds compose); the test helper creates the database if it is missing.

## File Structure

```
deno.json                     tasks, imports (exact versions), fmt, vendor, nodeModulesDir
deno.lock                     generated
tsconfig.eslint.json          ESLint-only TS config with jsr path mappings
eslint.config.ts              typescript-eslint strict + stylistic type-checked
drizzle.config.ts             schema src/db/schema.ts, out drizzle/
drizzle/                      generated migration SQL + meta (committed)
Dockerfile                    one image; command chosen by compose
compose.yaml                  db, migrate, http, sync
.env.example                  every variable config.ts reads
.githooks/pre-commit          runs deno task check
README.md                     per constitution "README" section
src/
  cli.ts                      Cliffy root: serve [--with-sync], sync, migrate
  config.ts                   env -> Config (zod)
  deps.ts                     Deps = { db, telegram, now }
  db/client.ts                createDb(url) -> { db, close }; Db, Tx, Executor types
  db/schema.ts                re-exports sync/models/schema.ts and telegram/models/schema.ts
  db/migrate.ts               runMigrations(db)
  db/tests/helpers.ts         withDb(fn): connect, ensure test db, migrate, truncate
  api/errors.ts               HttpError, errorHandler
  api/cursor.ts               encodeCursor/decodeCursor
  api/pagination.ts           pageQuerySchema, PageQuery, PageResult, toPage
  api/auth.ts                 bearerJwt(secret) middleware, signToken (tests)
  api/app.ts                  createApp({ jwtSecret, mounts })
  api/tests/*_test.ts
  sync/models/schema.ts       postCommentsSyncJobs, postCommentsSyncRuns, Platform
  sync/models/jobs.ts         ensureActiveJob, setJobActive, getJobByPost, pickJobs, heartbeat, fenceJob, releaseJob
  sync/models/runs.ts         openRun, closeRun
  sync/runner.ts              PlatformSyncRunner, Lease, RunOutcome, LeaseLost
  sync/run.ts                 runJob(deps, runner, job, leaseMs)
  sync/scheduler.ts           createScheduler(deps, runners, options)
  sync/tests/*_test.ts
  telegram/models/schema.ts   telegramPosts, telegramComments, indexes
  telegram/models/posts.ts    upsertPost, getPost, softDeletePost, markSyncSuccess, markSyncFailure, threadCoordinates
  telegram/models/comments.ts insertFromMessages, insertReply, getComment, listTopLevel, listReplies, markDeleted, refreshFromMessage, withHasReplies
  telegram/client/types.ts    Peer, User, Thread, Author, Message, Deleted, Page, Sent
  telegram/client/errors.ts   TelegramError classes with `kind`
  telegram/client/client.ts   TelegramClient interface, TelegramFactory
  telegram/client/fake.ts     FakeTelegram + seedDemo
  telegram/sync.ts            createTelegramSyncRunner(deps, { pageSize })
  telegram/api/errors.ts      translateSubmitError, translateReplyError, translateSyncError
  telegram/api/handlers/posts.ts     parsePostUrl, submitBodySchema, submitPost, getPostView, deletePost, serializePost
  telegram/api/handlers/comments.ts  replyBodySchema, validateReplyText, listComments, listReplies, replyToComment, serializeComment
  telegram/api/api.ts         createTelegramApi(deps): Hono
  telegram/tests/*_test.ts
```

Conventions used by every task below:

- Model functions take an `Executor` (a `Db` or a `Tx`) as first argument and never open transactions themselves; handlers and `sync/run.ts` open them.
- Telegram ids are JavaScript `number`s (bigint columns in `{ mode: "number" }`); the API serialises `author_id` as a string.
- Dates are `Date` objects in code and `timestamptz` in the database; API output uses `toISOString()`.
- Test files start with `import { assert, assertEquals, assertRejects } from "@std/assert";` and use `Deno.test("name", async () => { await withDb(async (db) => { ... }) })` where the database is needed.

---

### Task 1: Toolchain scaffold and config

**Files:**
- Create: `deno.json`, `tsconfig.eslint.json`, `eslint.config.ts`, `.gitignore`, `.githooks/pre-commit`, `src/config.ts`, `src/tests/config_test.ts`

**Interfaces:**
- Produces: `loadConfig(env: Record<string, string | undefined>): Config` and the `Config` type used by `cli.ts`.

- [ ] **Step 1: Write `deno.json`**

```json
{
  "nodeModulesDir": "auto",
  "vendor": true,
  "tasks": {
    "serve": "deno run -A src/cli.ts serve",
    "sync": "deno run -A src/cli.ts sync",
    "migrate": "deno run -A src/cli.ts migrate",
    "dev:serve": "deno run -A --watch src/cli.ts serve",
    "dev:sync": "deno run -A --watch src/cli.ts sync",
    "db:generate": "deno run -A npm:drizzle-kit generate",
    "test": "deno test -A src/",
    "lint": "deno run -A npm:eslint src/",
    "check": "deno check src/ && deno task lint && deno fmt --check",
    "hooks": "git config core.hooksPath .githooks"
  },
  "imports": {
    "@hono/hono": "jsr:@hono/hono@4.13.7",
    "@cliffy/command": "jsr:@cliffy/command@1.2.1",
    "@std/assert": "jsr:@std/assert@1.0.19",
    "zod": "npm:zod@4.6.2",
    "drizzle-orm": "npm:drizzle-orm@0.45.2",
    "drizzle-kit": "npm:drizzle-kit@0.31.10",
    "postgres": "npm:postgres@3.4.9",
    "eslint": "npm:eslint@10.10.0",
    "typescript-eslint": "npm:typescript-eslint@8.70.0",
    "@types/deno": "npm:@types/deno@2.7.0"
  },
  "fmt": {
    "lineWidth": 100,
    "indentWidth": 2,
    "useTabs": false,
    "singleQuote": false,
    "semiColons": true,
    "proseWrap": "preserve",
    "include": ["src/", "*.ts", "*.md", "*.json"],
    "exclude": ["drizzle/", "vendor/", "node_modules/"]
  },
  "exclude": ["vendor/", "node_modules/", "drizzle/"]
}
```

- [ ] **Step 2: Write `tsconfig.eslint.json`**

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noFallthroughCasesInSwitch": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["@types/deno"],
    "paths": {
      "@hono/hono": ["./vendor/jsr.io/@hono/hono/4.13.7/src/index.ts"],
      "@hono/hono/jwt": ["./vendor/jsr.io/@hono/hono/4.13.7/src/middleware/jwt/jwt.ts"],
      "@hono/hono/http-exception": ["./vendor/jsr.io/@hono/hono/4.13.7/src/http-exception.ts"],
      "@cliffy/command": ["./vendor/jsr.io/@cliffy/command/1.2.1/mod.ts"],
      "@std/assert": ["./vendor/jsr.io/@std/assert/1.0.19/mod.ts"]
    }
  },
  "include": ["src/**/*.ts", "*.ts"]
}
```

- [ ] **Step 3: Write `eslint.config.ts`**

```ts
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
```

- [ ] **Step 4: Write `.gitignore` and the hook**

`.gitignore`:

```
.env
node_modules/
vendor/
```

`.githooks/pre-commit` (then `chmod +x .githooks/pre-commit`):

```sh
#!/bin/sh
set -e
export PATH="$HOME/.deno/bin:$PATH"
deno task check
```

- [ ] **Step 5: Write the failing config test `src/tests/config_test.ts`**

```ts
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
```

- [ ] **Step 6: Run the test to see it fail**

Run: `deno install && deno test -A src/tests/config_test.ts`
Expected: FAIL, module `../config.ts` not found.

- [ ] **Step 7: Write `src/config.ts`**

```ts
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
```

- [ ] **Step 8: Run fmt, check, test**

Run: `deno fmt && deno task check && deno task test`
Expected: all pass. If `deno task lint` reports `no-unsafe-*` on `zod` or `Deno`, `deno install` has not populated `node_modules`; run it and retry.

- [ ] **Step 9: Commit**

```bash
git add deno.json deno.lock tsconfig.eslint.json eslint.config.ts .gitignore .githooks src/config.ts src/tests/config_test.ts
git commit -m "Scaffold Deno toolchain, lint config and typed config"
```

---

### Task 2: Database client, schemas, first migration, test helper

**Files:**
- Create: `src/db/client.ts`, `src/db/schema.ts`, `src/db/migrate.ts`, `src/db/tests/helpers.ts`, `src/db/tests/schema_test.ts`, `src/sync/models/schema.ts`, `src/telegram/models/schema.ts`, `drizzle.config.ts`, `compose.yaml` (db service only for now; Task 13 completes it), `drizzle/0000_*.sql` (generated)

**Interfaces:**
- Produces: `createDb(url): { db: Db; close(): Promise<void> }`, types `Db`, `Tx`, `Executor`; `runMigrations(db)`; `withDb(fn)` test helper; tables `postCommentsSyncJobs`, `postCommentsSyncRuns`, `telegramPosts`, `telegramComments`; `Platform` type and `platforms` tuple.

- [ ] **Step 1: Write `compose.yaml` with the db service**

```yaml
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: comments
    ports:
      - "5432:5432"
    volumes:
      - dbdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d comments"]
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  dbdata:
```

Run: `docker compose up -d db` and wait for `docker compose ps` to show healthy. (Postgres 18 images mount data at `/var/lib/postgresql`; if the container logs complain about the data directory, use `/var/lib/postgresql/data` instead.)

- [ ] **Step 2: Write `src/db/client.ts`**

```ts
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
```

- [ ] **Step 3: Write `src/sync/models/schema.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/telegram/models/schema.ts`**

```ts
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const postTypes = ["channel", "forum", "supergroup"] as const;
export type PostType = (typeof postTypes)[number];

export const telegramPosts = pgTable(
  "telegram_posts",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    username: text("username").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    postType: text("post_type").$type<PostType>().notNull(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    forumTopicId: bigint("forum_topic_id", { mode: "number" }),
    discussionChatId: bigint("discussion_chat_id", { mode: "number" }),
    discussionMessageId: bigint("discussion_message_id", { mode: "number" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncedMessageId: bigint("last_synced_message_id", { mode: "number" }),
    syncError: text("sync_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "telegram_posts_post_type_check",
      sql`${t.postType} in ('channel', 'forum', 'supergroup')`,
    ),
    uniqueIndex("telegram_posts_username_channel_message_uniq").on(
      t.username,
      t.channelId,
      t.messageId,
    ),
  ],
);

export const telegramComments = pgTable(
  "telegram_comments",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    postId: uuid("post_id").notNull().references(() => telegramPosts.id),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }).notNull(),
    replyToMessageId: bigint("reply_to_message_id", { mode: "number" }).notNull(),
    replyTo: uuid("reply_to").references((): AnyPgColumn => telegramComments.id),
    authorId: bigint("author_id", { mode: "number" }),
    authorUsername: text("author_username"),
    authorName: text("author_name"),
    text: text("text").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("telegram_comments_post_message_uniq").on(t.postId, t.telegramMessageId),
    index("telegram_comments_reply_to_idx")
      .on(t.replyTo, t.id)
      .where(sql`${t.replyTo} is not null`),
    index("telegram_comments_top_level_idx")
      .on(t.postId, t.id)
      .where(sql`${t.replyTo} is null`),
  ],
);
```

- [ ] **Step 5: Write `src/db/schema.ts` and `drizzle.config.ts`**

`src/db/schema.ts`:

```ts
export * from "../sync/models/schema.ts";
export * from "../telegram/models/schema.ts";
```

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: Deno.env.get("DATABASE_URL") ?? "postgres://postgres:postgres@localhost:5432/comments",
  },
});
```

- [ ] **Step 6: Generate and review the migration**

Run: `deno task db:generate`
Expected: `drizzle/0000_<name>.sql` and `drizzle/meta/`. Open the SQL and confirm: four tables; `DEFAULT uuidv7()` on every id; the three check constraints; unique index on `(username, channel_id, message_id)`; unique on `(post_id, telegram_message_id)`; partial indexes with `WHERE "reply_to" IS NOT NULL`, `WHERE "reply_to" IS NULL`, `WHERE "is_active"`; `locked_at ASC NULLS FIRST`; `started_at DESC`. If drizzle-kit emitted anything different from the spec's DDL, edit the SQL by hand to match the spec and keep the edit (the constitution allows edited generated SQL).

- [ ] **Step 7: Write `src/db/migrate.ts`**

```ts
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fromFileUrl } from "node:url";
import type { Db } from "./client.ts";

const migrationsFolder = fromFileUrl(new URL("../../drizzle", import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
```

(`fromFileUrl` from `node:url` is `fileURLToPath`; if `node:url` does not export `fromFileUrl`, use `import { fileURLToPath } from "node:url"`.)

- [ ] **Step 8: Write `src/db/tests/helpers.ts`**

```ts
import postgres from "postgres";
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
  const { sql } = await import("drizzle-orm");
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
```

Replace the dynamic `import("drizzle-orm")` with a top-level `import { sql } from "drizzle-orm";` (it is written inline above only to keep the snippet self-contained).

- [ ] **Step 9: Write the failing schema test `src/db/tests/schema_test.ts`**

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { sql } from "drizzle-orm";
import { telegramPosts } from "../../telegram/models/schema.ts";
import { postCommentsSyncJobs } from "../../sync/models/schema.ts";
import { withDb } from "./helpers.ts";

Deno.test("migrations create tables with uuidv7 ids", async () => {
  await withDb(async (db) => {
    const [post] = await db
      .insert(telegramPosts)
      .values({
        username: "u",
        title: "t",
        url: "https://t.me/u/1",
        postType: "channel",
        messageId: 1,
        channelId: 10,
      })
      .returning();
    assert(post !== undefined);
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/.test(post.id), "uuidv7 id");
    const [job] = await db
      .insert(postCommentsSyncJobs)
      .values({ postId: post.id, platform: "telegram" })
      .returning();
    assert(job !== undefined);
    assertEquals(job.isActive, true);
  });
});

Deno.test("one tracked post per (username, channel, message)", async () => {
  await withDb(async (db) => {
    const row = {
      username: "u",
      title: "t",
      url: "https://t.me/u/1",
      postType: "channel" as const,
      messageId: 1,
      channelId: 10,
    };
    await db.insert(telegramPosts).values(row);
    await assertRejects(() => db.insert(telegramPosts).values(row));
    await db.insert(telegramPosts).values({ ...row, username: "other" });
  });
});

Deno.test("post_type is checked", async () => {
  await withDb(async (db) => {
    await assertRejects(() =>
      db.execute(
        sql`insert into telegram_posts (username, title, url, post_type, message_id, channel_id)
            values ('u', 't', 'x', 'story', 1, 1)`,
      )
    );
  });
});
```

- [ ] **Step 10: Run the tests**

Run: `deno test -A src/db/`
Expected: PASS (three tests). If `uuidv7()` is unknown, the container is not PostgreSQL 18; check `docker compose ps`.

- [ ] **Step 11: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add compose.yaml drizzle.config.ts drizzle/ src/db src/sync/models/schema.ts src/telegram/models/schema.ts
git commit -m "Add database client, table declarations and first migration"
```

---

### Task 3: Telegram client interface, errors, fake client, Deps

**Files:**
- Create: `src/telegram/client/types.ts`, `src/telegram/client/errors.ts`, `src/telegram/client/client.ts`, `src/telegram/client/fake.ts`, `src/telegram/tests/fake_client_test.ts`, `src/deps.ts`

**Interfaces:**
- Produces: `TelegramClient` (six methods), `TelegramFactory`, error classes with `kind`, `FakeTelegram`, `seedDemo(fake)`, and `Deps = { db, telegram, now }`.

- [ ] **Step 1: Write `src/telegram/client/types.ts`**

```ts
export type PeerKind = "channel" | "supergroup" | "forum";

export interface Peer {
  chatId: number;
  kind: PeerKind;
}

export interface User {
  id: number;
  name: string;
}

export interface Thread {
  chatId: number;
  rootMessageId: number;
}

export interface Author {
  id: number;
  username: string | null;
  name: string;
}

export interface Message {
  kind: "message";
  id: number;
  replyToMessageId: number;
  author: Author | null;
  text: string;
  postedAt: Date;
  editedAt: Date | null;
}

export interface Deleted {
  kind: "deleted";
  id: number;
}

export interface Page {
  messages: Message[];
}

export interface Sent {
  messageId: number;
  postedAt: Date;
}
```

- [ ] **Step 2: Write `src/telegram/client/errors.ts`**

```ts
export type TelegramErrorKind =
  | "user_not_found"
  | "peer_not_found"
  | "no_discussion_group"
  | "message_not_found"
  | "forbidden"
  | "flood_wait"
  | "session_invalid"
  | "upstream";

export abstract class TelegramError extends Error {
  abstract readonly kind: TelegramErrorKind;
}

export class UserNotFound extends TelegramError {
  readonly kind = "user_not_found";
  constructor(readonly username: string) {
    super(`user ${username} not found`);
  }
}

export class PeerNotFound extends TelegramError {
  readonly kind = "peer_not_found";
  constructor(readonly ref: string) {
    super(`peer ${ref} not found`);
  }
}

export class NoDiscussionGroup extends TelegramError {
  readonly kind = "no_discussion_group";
  constructor(readonly channelId: number) {
    super(`channel ${String(channelId)} has no discussion group`);
  }
}

export class MessageNotFound extends TelegramError {
  readonly kind = "message_not_found";
  constructor(readonly chatId: number, readonly messageId: number) {
    super(`message ${String(messageId)} in chat ${String(chatId)} not found`);
  }
}

export class Forbidden extends TelegramError {
  readonly kind = "forbidden";
  constructor(reason: string) {
    super(reason);
  }
}

export class FloodWait extends TelegramError {
  readonly kind = "flood_wait";
  constructor(readonly retryAfter: number) {
    super(`FLOOD_WAIT_${String(retryAfter)}`);
  }
}

export class SessionInvalid extends TelegramError {
  readonly kind = "session_invalid";
  constructor(reason: string) {
    super(reason);
  }
}

export class Upstream extends TelegramError {
  readonly kind = "upstream";
  constructor(reason: string) {
    super(reason);
  }
}

export function isTelegramError(e: unknown): e is TelegramError {
  return e instanceof TelegramError;
}
```

- [ ] **Step 3: Write `src/telegram/client/client.ts`**

```ts
import type { Deleted, Message, Page, Peer, Sent, Thread, User } from "./types.ts";

/** The six calls of the internal Telegram library. All ids are bare integers, all dates UTC. */
export interface TelegramClient {
  resolvePeer(ref: string | number): Promise<Peer>;
  resolveUser(username: string): Promise<User>;
  getDiscussionThread(channelId: number, messageId: number): Promise<Thread>;
  getThreadMessages(
    chatId: number,
    rootMessageId: number,
    minId: number,
    limit: number,
  ): Promise<Page>;
  getMessages(chatId: number, ids: number[]): Promise<(Message | Deleted)[]>;
  sendReply(
    chatId: number,
    replyToMessageId: number,
    text: string,
    topicId: number | null,
  ): Promise<Sent>;
}

/** `for_user`: a handle for one account. Rejects with UserNotFound or Upstream. */
export type TelegramFactory = (username: string) => Promise<TelegramClient>;
```

- [ ] **Step 4: Write `src/deps.ts`**

```ts
import type { Db } from "./db/client.ts";
import type { TelegramFactory } from "./telegram/client/client.ts";

export interface Deps {
  db: Db;
  telegram: TelegramFactory;
  now: () => Date;
}
```

- [ ] **Step 5: Write the failing fake test `src/telegram/tests/fake_client_test.ts`**

```ts
import { assertEquals, assertRejects } from "@std/assert";
import { FakeTelegram } from "../client/fake.ts";
import { MessageNotFound, UserNotFound } from "../client/errors.ts";

function world(): FakeTelegram {
  const fake = new FakeTelegram();
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.addPeer(200, { chatId: 200, kind: "supergroup" });
  fake.linkDiscussion(100, 5, { chatId: 200, rootMessageId: 50 });
  fake.addThread(200, 50);
  return fake;
}

Deno.test("forUser rejects unknown accounts", async () => {
  const fake = world();
  await assertRejects(() => fake.forUser("bob"), UserNotFound);
});

Deno.test("resolvePeer by username and by id", async () => {
  const c = await world().forUser("alice");
  assertEquals(await c.resolvePeer("mychannel"), { chatId: 100, kind: "channel" });
  assertEquals(await c.resolvePeer(200), { chatId: 200, kind: "supergroup" });
});

Deno.test("thread messages page ascending above minId", async () => {
  const fake = world();
  fake.addMessage(200, 50, { id: 51, replyToMessageId: 50, text: "a" });
  fake.addMessage(200, 50, { id: 52, replyToMessageId: 51, text: "b" });
  fake.addMessage(200, 50, { id: 53, replyToMessageId: 50, text: "c" });
  const c = await fake.forUser("alice");
  const page = await c.getThreadMessages(200, 50, 51, 100);
  assertEquals(page.messages.map((m) => m.id), [52, 53]);
  const limited = await c.getThreadMessages(200, 50, 0, 2);
  assertEquals(limited.messages.map((m) => m.id), [51, 52]);
});

Deno.test("getMessages reports missing ids as deleted", async () => {
  const fake = world();
  fake.addMessage(200, 50, { id: 51, replyToMessageId: 50, text: "a" });
  const c = await fake.forUser("alice");
  const got = await c.getMessages(200, [51, 99]);
  assertEquals(got.map((m) => m.kind), ["message", "deleted"]);
});

Deno.test("sendReply appends the account's message to the thread", async () => {
  const fake = world();
  fake.addMessage(200, 50, { id: 51, replyToMessageId: 50, text: "a" });
  const c = await fake.forUser("alice");
  const sent = await c.sendReply(200, 51, "hi", null);
  const [m] = await c.getMessages(200, [sent.messageId]);
  assertEquals(m?.kind, "message");
  if (m?.kind === "message") {
    assertEquals(m.author, { id: 1, username: "alice", name: "Alice" });
    assertEquals(m.replyToMessageId, 51);
  }
  await assertRejects(() => c.sendReply(200, 999, "x", null), MessageNotFound);
});

Deno.test("failNext makes the next call throw", async () => {
  const fake = world();
  const c = await fake.forUser("alice");
  fake.failNext(new MessageNotFound(200, 50));
  await assertRejects(() => c.getThreadMessages(200, 50, 0, 10), MessageNotFound);
  assertEquals((await c.getThreadMessages(200, 50, 0, 10)).messages, []);
});
```

- [ ] **Step 6: Run the test to see it fail**

Run: `deno test -A src/telegram/tests/fake_client_test.ts`
Expected: FAIL, `../client/fake.ts` not found.

- [ ] **Step 7: Write `src/telegram/client/fake.ts`**

```ts
import type { TelegramClient } from "./client.ts";
import { MessageNotFound, NoDiscussionGroup, PeerNotFound, TelegramError, UserNotFound } from "./errors.ts";
import type { Deleted, Message, Page, Peer, Sent, Thread, User } from "./types.ts";

export interface FakeMessageInput {
  id: number;
  replyToMessageId: number;
  text: string;
  author?: Message["author"];
  postedAt?: Date;
  editedAt?: Date | null;
}

interface FakeThread {
  chatId: number;
  rootMessageId: number;
  messages: Map<number, Message>;
}

function threadKey(chatId: number, rootMessageId: number): string {
  return `${String(chatId)}:${String(rootMessageId)}`;
}

/** In-memory Telegram world shared by every client the factory hands out. */
export class FakeTelegram {
  readonly accounts = new Map<string, User>();
  readonly peers = new Map<string, Peer>();
  readonly discussions = new Map<string, Thread>();
  readonly threads = new Map<string, FakeThread>();
  readonly calls: string[] = [];
  private pendingFailure: TelegramError | null = null;
  private nextId = 1000;
  clock: () => Date = () => new Date();

  addAccount(username: string, user: User): void {
    this.accounts.set(username, user);
  }

  addPeer(ref: string | number, peer: Peer): void {
    this.peers.set(String(ref), peer);
  }

  linkDiscussion(channelId: number, messageId: number, thread: Thread): void {
    this.discussions.set(threadKey(channelId, messageId), thread);
    this.addThread(thread.chatId, thread.rootMessageId);
  }

  addThread(chatId: number, rootMessageId: number): void {
    const key = threadKey(chatId, rootMessageId);
    if (!this.threads.has(key)) {
      this.threads.set(key, { chatId, rootMessageId, messages: new Map() });
    }
  }

  addMessage(chatId: number, rootMessageId: number, input: FakeMessageInput): Message {
    this.addThread(chatId, rootMessageId);
    const thread = this.threads.get(threadKey(chatId, rootMessageId));
    if (thread === undefined) throw new Error("unreachable");
    const message: Message = {
      kind: "message",
      id: input.id,
      replyToMessageId: input.replyToMessageId,
      author: input.author ?? { id: 500 + input.id, username: `user${String(input.id)}`, name: `User ${String(input.id)}` },
      text: input.text,
      postedAt: input.postedAt ?? this.clock(),
      editedAt: input.editedAt ?? null,
    };
    thread.messages.set(message.id, message);
    this.nextId = Math.max(this.nextId, message.id + 1);
    return message;
  }

  /** Edits a stored message the way a Telegram user would: new text and edit date. */
  editMessage(chatId: number, messageId: number, text: string, editedAt: Date): void {
    const found = this.findMessage(chatId, messageId);
    if (found === null) throw new Error(`no message ${String(messageId)}`);
    found.thread.messages.set(messageId, { ...found.message, text, editedAt });
  }

  deleteMessage(chatId: number, messageId: number): void {
    const found = this.findMessage(chatId, messageId);
    if (found !== null) found.thread.messages.delete(messageId);
  }

  failNext(error: TelegramError): void {
    this.pendingFailure = error;
  }

  forUser(username: string): Promise<TelegramClient> {
    this.calls.push(`forUser(${username})`);
    const failure = this.takeFailure();
    if (failure !== null) return Promise.reject(failure);
    const user = this.accounts.get(username);
    if (user === undefined) return Promise.reject(new UserNotFound(username));
    return Promise.resolve(new FakeClient(this, username, user));
  }

  takeFailure(): TelegramError | null {
    const f = this.pendingFailure;
    this.pendingFailure = null;
    return f;
  }

  allocateId(): number {
    return this.nextId++;
  }

  findMessage(chatId: number, messageId: number): { thread: FakeThread; message: Message } | null {
    for (const thread of this.threads.values()) {
      if (thread.chatId !== chatId) continue;
      const message = thread.messages.get(messageId);
      if (message !== undefined) return { thread, message };
    }
    return null;
  }
}

class FakeClient implements TelegramClient {
  constructor(
    private readonly world: FakeTelegram,
    private readonly username: string,
    private readonly self: User,
  ) {}

  private guard(call: string): Promise<void> {
    this.world.calls.push(call);
    const failure = this.world.takeFailure();
    return failure === null ? Promise.resolve() : Promise.reject(failure);
  }

  async resolvePeer(ref: string | number): Promise<Peer> {
    await this.guard(`resolvePeer(${String(ref)})`);
    const peer = this.world.peers.get(String(ref));
    if (peer === undefined) throw new PeerNotFound(String(ref));
    return peer;
  }

  async resolveUser(username: string): Promise<User> {
    await this.guard(`resolveUser(${username})`);
    const user = this.world.accounts.get(username);
    if (user === undefined) throw new PeerNotFound(username);
    return user;
  }

  async getDiscussionThread(channelId: number, messageId: number): Promise<Thread> {
    await this.guard(`getDiscussionThread(${String(channelId)}, ${String(messageId)})`);
    const thread = this.world.discussions.get(threadKey(channelId, messageId));
    if (thread !== undefined) return thread;
    const hasAnyDiscussion = [...this.world.discussions.keys()].some((k) =>
      k.startsWith(`${String(channelId)}:`)
    );
    if (!hasAnyDiscussion) throw new NoDiscussionGroup(channelId);
    throw new MessageNotFound(channelId, messageId);
  }

  async getThreadMessages(
    chatId: number,
    rootMessageId: number,
    minId: number,
    limit: number,
  ): Promise<Page> {
    await this.guard(`getThreadMessages(${String(chatId)}, ${String(rootMessageId)}, ${String(minId)}, ${String(limit)})`);
    const thread = this.world.threads.get(threadKey(chatId, rootMessageId));
    if (thread === undefined) throw new MessageNotFound(chatId, rootMessageId);
    const messages = [...thread.messages.values()]
      .filter((m) => m.id > minId)
      .sort((a, b) => a.id - b.id)
      .slice(0, Math.min(limit, 100));
    return { messages };
  }

  async getMessages(chatId: number, ids: number[]): Promise<(Message | Deleted)[]> {
    await this.guard(`getMessages(${String(chatId)}, [${ids.join(",")}])`);
    return ids.map((id) => {
      const found = this.world.findMessage(chatId, id);
      return found === null ? { kind: "deleted", id } : found.message;
    });
  }

  async sendReply(
    chatId: number,
    replyToMessageId: number,
    text: string,
    topicId: number | null,
  ): Promise<Sent> {
    await this.guard(`sendReply(${String(chatId)}, ${String(replyToMessageId)}, ${JSON.stringify(text)}, ${String(topicId)})`);
    const target = this.world.findMessage(chatId, replyToMessageId);
    if (target === null) throw new MessageNotFound(chatId, replyToMessageId);
    const message: Message = {
      kind: "message",
      id: this.world.allocateId(),
      replyToMessageId,
      author: { id: this.self.id, username: this.username, name: this.self.name },
      text,
      postedAt: this.world.clock(),
      editedAt: null,
    };
    target.thread.messages.set(message.id, message);
    return { messageId: message.id, postedAt: message.postedAt };
  }
}

/** A small world for the local environment: account `demo`, channel `demo_channel`, one post with two comments. */
export function seedDemo(fake: FakeTelegram): void {
  fake.addAccount("demo", { id: 42, name: "Demo Account" });
  fake.addPeer("demo_channel", { chatId: 1001, kind: "channel" });
  fake.addPeer(1001, { chatId: 1001, kind: "channel" });
  fake.addPeer("demo_group", { chatId: 2002, kind: "supergroup" });
  fake.addPeer(2002, { chatId: 2002, kind: "supergroup" });
  fake.linkDiscussion(1001, 1, { chatId: 2002, rootMessageId: 10 });
  fake.addMessage(2002, 10, { id: 11, replyToMessageId: 10, text: "first!" });
  fake.addMessage(2002, 10, { id: 12, replyToMessageId: 11, text: "no, second" });
}
```

Notes: `getDiscussionThread` in the fake distinguishes NoDiscussionGroup (channel has no linked discussion at all) from MessageNotFound (channel is linked but this message has no thread) the way the spec says the library does. `resolveUser` on the fake resolves only account usernames; that is what the reply handler needs.

- [ ] **Step 8: Run the tests**

Run: `deno test -A src/telegram/tests/fake_client_test.ts`
Expected: PASS (six tests).

- [ ] **Step 9: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/telegram/client src/telegram/tests/fake_client_test.ts src/deps.ts
git commit -m "Add Telegram client interface, error kinds and in-memory fake"
```

---

### Task 4: Platform-agnostic API foundation

**Files:**
- Create: `src/api/errors.ts`, `src/api/cursor.ts`, `src/api/pagination.ts`, `src/api/auth.ts`, `src/api/app.ts`, `src/api/tests/cursor_test.ts`, `src/api/tests/pagination_test.ts`, `src/api/tests/app_test.ts`

**Interfaces:**
- Produces: `HttpError`, `errorHandler`, `encodeCursor/decodeCursor`, `pageQuerySchema`, `PageQuery { limit; after }`, `PageResult<T> { items; next_cursor; has_more }`, `toPage(rows, limit)`, `bearerJwt(secret)`, `signToken(secret, subject)`, `createApp({ jwtSecret, mounts })`.

- [ ] **Step 1: Write the failing tests**

`src/api/tests/cursor_test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { decodeCursor, encodeCursor } from "../cursor.ts";
import { HttpError } from "../errors.ts";

Deno.test("cursor round-trips an id", () => {
  const id = "01a08dcf-9995-704a-ac33-2c6e6233dcb8";
  const cursor = encodeCursor(id);
  assertEquals(JSON.parse(atob(cursor)), { after: id });
  assertEquals(decodeCursor(cursor), id);
});

Deno.test("malformed cursors are 400 malformed_cursor", () => {
  const err = assertThrows(() => decodeCursor("not-base64!"), HttpError);
  assertEquals(err.status, 400);
  assertEquals(err.code, "malformed_cursor");
  assertThrows(() => decodeCursor(btoa(JSON.stringify({ after: 5 }))), HttpError);
});
```

`src/api/tests/pagination_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { pageQuerySchema, toPage } from "../pagination.ts";

Deno.test("pageQuerySchema defaults and bounds", () => {
  assertEquals(pageQuerySchema.parse({}), { limit: 20, cursor: undefined });
  assertEquals(pageQuerySchema.parse({ limit: "5" }).limit, 5);
  assertEquals(pageQuerySchema.safeParse({ limit: "0" }).success, false);
  assertEquals(pageQuerySchema.safeParse({ limit: "101" }).success, false);
});

Deno.test("toPage cuts the extra row and points the cursor at the last item", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const page = toPage(rows, 2);
  assertEquals(page.items.map((r) => r.id), ["a", "b"]);
  assertEquals(page.has_more, true);
  assertEquals(page.next_cursor, btoa(JSON.stringify({ after: "b" })));
  const last = toPage([{ id: "c" }], 2);
  assertEquals(last.has_more, false);
  assertEquals(last.next_cursor, null);
});
```

`src/api/tests/app_test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import { createApp } from "../app.ts";
import { signToken } from "../auth.ts";
import { HttpError } from "../errors.ts";

const secret = "test-secret";

function app(): Hono {
  const sub = new Hono();
  sub.get("/ok", (c) => c.json({ status: 200 }));
  sub.get("/boom", () => {
    throw new HttpError(404, "post_not_found", "post x not found", { extra: 1 });
  });
  sub.get("/crash", () => {
    throw new Error("unexpected");
  });
  return createApp({ jwtSecret: secret, mounts: [{ path: "/telegram/v1", app: sub }] });
}

Deno.test("health needs no token", async () => {
  const res = await app().request("/health");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: 200, ok: true });
});

Deno.test("mounted routes require a valid bearer token", async () => {
  const a = app();
  const missing = await a.request("/telegram/v1/ok");
  assertEquals(missing.status, 401);
  assertEquals((await missing.json()).code, "unauthorized");
  const bad = await a.request("/telegram/v1/ok", { headers: { Authorization: "Bearer nope" } });
  assertEquals(bad.status, 401);
  const token = await signToken(secret, "service");
  const ok = await a.request("/telegram/v1/ok", { headers: { Authorization: `Bearer ${token}` } });
  assertEquals(ok.status, 200);
});

Deno.test("HttpError is serialised with status, code, message and extras", async () => {
  const token = await signToken(secret, "service");
  const res = await app().request("/telegram/v1/boom", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assertEquals(res.status, 404);
  assertEquals(await res.json(), {
    status: 404,
    code: "post_not_found",
    message: "post x not found",
    extra: 1,
  });
});

Deno.test("unexpected errors are 500 internal_error", async () => {
  const token = await signToken(secret, "service");
  const res = await app().request("/telegram/v1/crash", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assertEquals(res.status, 500);
  assertEquals((await res.json()).code, "internal_error");
});

Deno.test("unknown routes are 404 not_found", async () => {
  const token = await signToken(secret, "service");
  const res = await app().request("/nope", { headers: { Authorization: `Bearer ${token}` } });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).code, "not_found");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `deno test -A src/api/`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/api/errors.ts`**

```ts
import type { Context } from "@hono/hono";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  body(): Record<string, unknown> {
    return { status: this.status, code: this.code, message: this.message, ...this.extra };
  }

  toResponse(): Response {
    return Response.json(this.body(), { status: this.status });
  }
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof HttpError) return err.toResponse();
  console.error(`${c.req.method} ${c.req.path}:`, err);
  return new HttpError(500, "internal_error", "internal error").toResponse();
}

export function notFoundHandler(c: Context): Response {
  return new HttpError(404, "not_found", `no route for ${c.req.method} ${c.req.path}`).toResponse();
}
```

- [ ] **Step 4: Write `src/api/cursor.ts`**

```ts
import { z } from "zod";
import { HttpError } from "./errors.ts";

const cursorSchema = z.object({ after: z.string().min(1) });

export function encodeCursor(afterId: string): string {
  return btoa(JSON.stringify({ after: afterId }));
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    return cursorSchema.parse(parsed).after;
  } catch {
    throw new HttpError(400, "malformed_cursor", "cursor is not a valid page cursor");
  }
}
```

- [ ] **Step 5: Write `src/api/pagination.ts`**

```ts
import { z } from "zod";
import { decodeCursor, encodeCursor } from "./cursor.ts";

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

export interface PageQuery {
  limit: number;
  after: string | null;
}

export interface PageResult<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export function toPageQuery(raw: z.infer<typeof pageQuerySchema>): PageQuery {
  return { limit: raw.limit, after: raw.cursor === undefined ? null : decodeCursor(raw.cursor) };
}

/** `rows` were fetched with `limit + 1`; the extra row only says whether there is a next page. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): PageResult<T> {
  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    has_more,
    next_cursor: has_more && last !== undefined ? encodeCursor(last.id) : null,
  };
}
```

- [ ] **Step 6: Write `src/api/auth.ts`**

```ts
import type { MiddlewareHandler } from "@hono/hono";
import { sign, verify } from "@hono/hono/jwt";
import { HttpError } from "./errors.ts";

const ALG = "HS256";

export function bearerJwt(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || token === undefined || token === "") {
      throw new HttpError(401, "unauthorized", "missing bearer token");
    }
    try {
      await verify(token, secret, ALG);
    } catch {
      throw new HttpError(401, "unauthorized", "invalid bearer token");
    }
    await next();
  };
}

/** Issues a service token; used by tests and by the README's curl example. */
export function signToken(secret: string, subject: string, ttlSeconds = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: subject, iat: now, exp: now + ttlSeconds }, secret, ALG);
}
```

- [ ] **Step 7: Write `src/api/app.ts`**

```ts
import { Hono } from "@hono/hono";
import { bearerJwt } from "./auth.ts";
import { errorHandler, notFoundHandler } from "./errors.ts";

export interface Mount {
  path: string;
  app: Hono;
}

export interface AppOptions {
  jwtSecret: string;
  mounts: Mount[];
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.get("/health", (c) => c.json({ status: 200, ok: true }));
  const auth = bearerJwt(options.jwtSecret);
  for (const mount of options.mounts) {
    app.use(`${mount.path}/*`, auth);
    app.route(mount.path, mount.app);
  }
  return app;
}
```

- [ ] **Step 8: Run the tests**

Run: `deno test -A src/api/`
Expected: PASS. If Hono's `route()` type complains about sub-app generics, type `Mount.app` as `Hono<any>` is NOT allowed; use `Hono<BlankEnv, BlankSchema, "/">` from `@hono/hono` or keep `Hono` and adjust the sub-app construction in tests to `new Hono()` (matching types).

- [ ] **Step 9: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/api
git commit -m "Add HTTP foundation: errors, cursor paging, bearer JWT, root app"
```

---

### Task 5: Sync job and run models (lease SQL)

**Files:**
- Create: `src/sync/models/jobs.ts`, `src/sync/models/runs.ts`, `src/sync/tests/jobs_test.ts`, `src/sync/tests/runs_test.ts`

**Interfaces:**
- Consumes: `Executor`, `Tx` from `src/db/client.ts`; tables from `src/sync/models/schema.ts`.
- Produces:
  - `interface PickedJob { id: string; postId: string; platform: Platform; leaseToken: string }`
  - `ensureActiveJob(ex, { postId, platform }): Promise<void>` — insert, or on conflict set `is_active = true`.
  - `setJobActive(ex, { postId, platform }, active: boolean): Promise<void>`
  - `getJobByPost(ex, { postId, platform }): Promise<{ id: string; isActive: boolean } | null>`
  - `pickJobs(ex, { batchSize, leaseMs }): Promise<PickedJob[]>`
  - `heartbeatJob(ex, jobId, leaseToken, leaseMs): Promise<boolean>` — false when the token no longer matches.
  - `fenceJob(tx, jobId, leaseToken): Promise<boolean>` — `select ... for update where id and lease_token`; false when zero rows.
  - `releaseJob(ex, jobId, leaseToken, { disable }): Promise<void>` — clears `locked_until`, sets `is_active = false` when `disable`, only where the token matches.
  - `openRun(ex, { jobId, postId, platform, startedAt }): Promise<string>` (run id)
  - `closeRun(ex, runId, { finishedAt, status: "success" | "failure", error: string | null }): Promise<void>`
  - `listRunsForPost(ex, postId): Promise<RunRow[]>` (tests and debugging)

- [ ] **Step 1: Write the failing job tests `src/sync/tests/jobs_test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { withDb } from "../../db/tests/helpers.ts";
import {
  ensureActiveJob,
  fenceJob,
  getJobByPost,
  heartbeatJob,
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
    for (const j of [...first, ...second]) await releaseJob(db, j.id, j.leaseToken, { disable: false });
    const third = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(third.map((j) => j.postId), [first[0]?.postId], "round-robin by locked_at");
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

Deno.test("heartbeat, fence and release honour the lease token", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId: p(1), platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    assertEquals(await heartbeatJob(db, job.id, job.leaseToken, 60_000), true);
    assertEquals(await heartbeatJob(db, job.id, p(9), 60_000), false);
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
```

- [ ] **Step 2: Write the failing run tests `src/sync/tests/runs_test.ts`**

```ts
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
    const runId = await openRun(db, { jobId: job.id, postId, platform: "telegram", startedAt: started });
    let [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "running");
    assertEquals(run?.finishedAt, null);
    await closeRun(db, runId, { finishedAt: new Date("2026-01-01T10:00:01Z"), status: "failure", error: "boom" });
    [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "failure");
    assertEquals(run?.error, "boom");
    assertEquals(run?.finishedAt?.toISOString(), "2026-01-01T10:00:01.000Z");
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `deno test -A src/sync/`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/sync/models/jobs.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import type { Executor, Tx } from "../../db/client.ts";
import { type Platform, postCommentsSyncJobs } from "./schema.ts";

export interface JobKey {
  postId: string;
  platform: Platform;
}

export interface PickedJob {
  id: string;
  postId: string;
  platform: Platform;
  leaseToken: string;
}

export async function ensureActiveJob(ex: Executor, key: JobKey): Promise<void> {
  await ex
    .insert(postCommentsSyncJobs)
    .values({ postId: key.postId, platform: key.platform, isActive: true })
    .onConflictDoUpdate({
      target: [postCommentsSyncJobs.platform, postCommentsSyncJobs.postId],
      set: { isActive: true },
    });
}

export async function setJobActive(ex: Executor, key: JobKey, active: boolean): Promise<void> {
  await ex
    .update(postCommentsSyncJobs)
    .set({ isActive: active })
    .where(
      and(
        eq(postCommentsSyncJobs.postId, key.postId),
        eq(postCommentsSyncJobs.platform, key.platform),
      ),
    );
}

export async function getJobByPost(
  ex: Executor,
  key: JobKey,
): Promise<{ id: string; isActive: boolean } | null> {
  const rows = await ex
    .select({ id: postCommentsSyncJobs.id, isActive: postCommentsSyncJobs.isActive })
    .from(postCommentsSyncJobs)
    .where(
      and(
        eq(postCommentsSyncJobs.postId, key.postId),
        eq(postCommentsSyncJobs.platform, key.platform),
      ),
    );
  return rows[0] ?? null;
}

interface PickedRow extends Record<string, unknown> {
  id: string;
  post_id: string;
  platform: Platform;
  lease_token: string;
}

/** The pick statement from the spec: lease a batch of due jobs, least recently locked first. */
export async function pickJobs(
  ex: Executor,
  options: { batchSize: number; leaseMs: number },
): Promise<PickedJob[]> {
  const interval = sql`make_interval(secs => ${options.leaseMs} / 1000.0)`;
  const rows = await ex.execute<PickedRow>(sql`
    update post_comments_sync_jobs j
      set locked_at = now(),
          locked_until = now() + ${interval},
          lease_token = uuidv7()
    where j.id in (
      select id from post_comments_sync_jobs
      where is_active and (locked_until is null or locked_until < now())
      order by locked_at asc nulls first
      limit ${options.batchSize}
      for update skip locked
    )
    returning j.id, j.post_id, j.platform, j.lease_token
  `);
  return [...rows].map((r) => ({
    id: r.id,
    postId: r.post_id,
    platform: r.platform,
    leaseToken: r.lease_token,
  }));
}

export async function heartbeatJob(
  ex: Executor,
  jobId: string,
  leaseToken: string,
  leaseMs: number,
): Promise<boolean> {
  const rows = await ex
    .update(postCommentsSyncJobs)
    .set({ lockedUntil: sql`now() + make_interval(secs => ${leaseMs} / 1000.0)` })
    .where(
      and(eq(postCommentsSyncJobs.id, jobId), eq(postCommentsSyncJobs.leaseToken, leaseToken)),
    )
    .returning({ id: postCommentsSyncJobs.id });
  return rows.length > 0;
}

/** First statement of every run transaction: re-take the job row under the token. */
export async function fenceJob(tx: Tx, jobId: string, leaseToken: string): Promise<boolean> {
  const rows = await tx
    .select({ id: postCommentsSyncJobs.id })
    .from(postCommentsSyncJobs)
    .where(
      and(eq(postCommentsSyncJobs.id, jobId), eq(postCommentsSyncJobs.leaseToken, leaseToken)),
    )
    .for("update");
  return rows.length > 0;
}

export async function releaseJob(
  ex: Executor,
  jobId: string,
  leaseToken: string,
  options: { disable: boolean },
): Promise<void> {
  await ex
    .update(postCommentsSyncJobs)
    .set({
      lockedUntil: null,
      ...(options.disable ? { isActive: false } : {}),
    })
    .where(
      and(eq(postCommentsSyncJobs.id, jobId), eq(postCommentsSyncJobs.leaseToken, leaseToken)),
    );
}
```

If `ex.execute<PickedRow>` is not generic on your drizzle version, use `const rows = (await ex.execute(sql\`...\`)) as unknown as PickedRow[]` is NOT allowed (unsafe). Instead parse each row with a zod schema `z.object({ id: z.string(), post_id: z.string(), platform: z.enum(platforms), lease_token: z.string() })`.

- [ ] **Step 5: Write `src/sync/models/runs.ts`**

```ts
import { desc, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { type Platform, postCommentsSyncRuns } from "./schema.ts";

export type RunRow = typeof postCommentsSyncRuns.$inferSelect;

export async function openRun(
  ex: Executor,
  input: { jobId: string; postId: string; platform: Platform; startedAt: Date },
): Promise<string> {
  const rows = await ex
    .insert(postCommentsSyncRuns)
    .values({ ...input, status: "running" })
    .returning({ id: postCommentsSyncRuns.id });
  const row = rows[0];
  if (row === undefined) throw new Error("openRun returned no row");
  return row.id;
}

export async function closeRun(
  ex: Executor,
  runId: string,
  input: { finishedAt: Date; status: "success" | "failure"; error: string | null },
): Promise<void> {
  await ex
    .update(postCommentsSyncRuns)
    .set({ finishedAt: input.finishedAt, status: input.status, error: input.error })
    .where(eq(postCommentsSyncRuns.id, runId));
}

export function listRunsForPost(ex: Executor, postId: string): Promise<RunRow[]> {
  return ex
    .select()
    .from(postCommentsSyncRuns)
    .where(eq(postCommentsSyncRuns.postId, postId))
    .orderBy(desc(postCommentsSyncRuns.startedAt));
}
```

- [ ] **Step 6: Run the tests**

Run: `deno test -A src/sync/`
Expected: PASS (five tests).

- [ ] **Step 7: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/sync
git commit -m "Add sync job lease and run models"
```

---

### Task 6: Runner contract, fenced run, scheduler

**Files:**
- Create: `src/sync/runner.ts`, `src/sync/run.ts`, `src/sync/scheduler.ts`, `src/sync/tests/run_test.ts`, `src/sync/tests/scheduler_test.ts`

**Interfaces:**
- Consumes: Task 5 job/run functions; `Deps` from `src/deps.ts`.
- Produces:

```ts
// src/sync/runner.ts
export type RunOutcome =
  | { status: "success" }
  | { status: "failure"; error: string; disable: boolean };

export class LeaseLost extends Error {}

export interface Lease {
  readonly token: string;
  /** The run's one fenced transaction: re-takes the job row, runs `fn`, closes the run row
   *  and releases the lease, then commits. Rejects with LeaseLost (nothing written) when the
   *  token no longer matches. A runner calls it exactly once, as its last act. */
  commit(fn: (tx: Tx) => Promise<RunOutcome>): Promise<RunOutcome>;
}

export interface PlatformSyncRunner {
  readonly platform: Platform;
  run(job: PickedJob, lease: Lease): Promise<RunOutcome>;
}

// src/sync/run.ts
export function runJob(deps: Deps, runner: PlatformSyncRunner, job: PickedJob, leaseMs: number): Promise<RunOutcome>

// src/sync/scheduler.ts
export interface SchedulerOptions { tickMs: number; batchSize: number; leaseMs: number; concurrency: number }
export interface Scheduler { tick(): Promise<void>; start(): void; stop(): Promise<void> }
export function createScheduler(deps: Deps, runners: PlatformSyncRunner[], options: SchedulerOptions): Scheduler
```

- [ ] **Step 1: Write the failing run tests `src/sync/tests/run_test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import type { Deps } from "../../deps.ts";
import { withDb } from "../../db/tests/helpers.ts";
import { UserNotFound } from "../../telegram/client/errors.ts";
import { ensureActiveJob, getJobByPost, pickJobs } from "../models/jobs.ts";
import { listRunsForPost } from "../models/runs.ts";
import { runJob } from "../run.ts";
import type { PlatformSyncRunner } from "../runner.ts";
import type { Db } from "../../db/client.ts";

const postId = "0199a000-0000-7000-8000-000000000001";

function deps(db: Db): Deps {
  return { db, telegram: () => Promise.reject(new UserNotFound("x")), now: () => new Date() };
}

Deno.test("a successful run closes the run row and releases the lease", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: (_job, lease) => lease.commit(() => Promise.resolve({ status: "success" })),
    };
    const outcome = await runJob(deps(db), runner, job, 60_000);
    assertEquals(outcome, { status: "success" });
    const [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "success");
    const again = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(again.length, 1, "lease was released");
  });
});

Deno.test("a failure with disable closes the run as failure and disables the job", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: (_job, lease) =>
        lease.commit(() =>
          Promise.resolve({ status: "failure", error: "session_invalid: revoked", disable: true })
        ),
    };
    await runJob(deps(db), runner, job, 60_000);
    const [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "failure");
    assertEquals(run?.error, "session_invalid: revoked");
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, false);
  });
});

Deno.test("a runner that throws closes the run as failure and releases", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: () => Promise.reject(new Error("bug")),
    };
    const outcome = await runJob(deps(db), runner, job, 60_000);
    assertEquals(outcome.status, "failure");
    const [run] = await listRunsForPost(db, postId);
    assertEquals(run?.status, "failure");
    assertEquals(run?.error, "bug");
    assertEquals((await pickJobs(db, { batchSize: 1, leaseMs: 60_000 })).length, 1);
  });
});

Deno.test("a lost lease rolls back and closes the run as 'lease lost'", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 1 });
    assert(job !== undefined);
    await new Promise((r) => setTimeout(r, 20));
    const [stolen] = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assert(stolen !== undefined && stolen.leaseToken !== job.leaseToken);
    let wroteInside = false;
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: (_job, lease) =>
        lease.commit(() => {
          wroteInside = true;
          return Promise.resolve({ status: "success" });
        }),
    };
    const outcome = await runJob(deps(db), runner, job, 60_000);
    assertEquals(outcome, { status: "failure", error: "lease lost", disable: false });
    assertEquals(wroteInside, false);
    const runs = await listRunsForPost(db, postId);
    assertEquals(runs[0]?.error, "lease lost");
    const held = await pickJobs(db, { batchSize: 1, leaseMs: 60_000 });
    assertEquals(held.length, 0, "the new holder's lease is untouched");
  });
});

Deno.test("heartbeat keeps a long call from being picked twice", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId, platform: "telegram" });
    const [job] = await pickJobs(db, { batchSize: 1, leaseMs: 200 });
    assert(job !== undefined);
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: async (_job, lease) => {
        await new Promise((r) => setTimeout(r, 450));
        return lease.commit(() => Promise.resolve({ status: "success" }));
      },
    };
    const running = runJob(deps(db), runner, job, 200);
    await new Promise((r) => setTimeout(r, 300));
    assertEquals((await pickJobs(db, { batchSize: 1, leaseMs: 200 })).length, 0, "still leased");
    assertEquals(await running, { status: "success" });
  });
});
```

- [ ] **Step 2: Write the failing scheduler test `src/sync/tests/scheduler_test.ts`**

```ts
import { assertEquals } from "@std/assert";
import type { Deps } from "../../deps.ts";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import { UserNotFound } from "../../telegram/client/errors.ts";
import { ensureActiveJob } from "../models/jobs.ts";
import { listRunsForPost } from "../models/runs.ts";
import type { PlatformSyncRunner } from "../runner.ts";
import { createScheduler } from "../scheduler.ts";

const p = (n: number): string => `0199a000-0000-7000-8000-00000000000${String(n)}`;

function deps(db: Db): Deps {
  return { db, telegram: () => Promise.reject(new UserNotFound("x")), now: () => new Date() };
}

Deno.test("tick runs every picked job through its platform runner", async () => {
  await withDb(async (db) => {
    for (const n of [1, 2, 3]) await ensureActiveJob(db, { postId: p(n), platform: "telegram" });
    const seen: string[] = [];
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: (job, lease) => {
        seen.push(job.postId);
        return lease.commit(() => Promise.resolve({ status: "success" }));
      },
    };
    const s = createScheduler(deps(db), [runner], {
      tickMs: 10_000,
      batchSize: 2,
      leaseMs: 60_000,
      concurrency: 5,
    });
    await s.tick();
    await s.stop();
    assertEquals(seen.length, 2, "batch size caps a tick");
    await s.tick();
    await s.stop();
    assertEquals(seen.sort(), [p(1), p(2), p(3)]);
  });
});

Deno.test("concurrency cap limits in-flight runs", async () => {
  await withDb(async (db) => {
    for (const n of [1, 2, 3]) await ensureActiveJob(db, { postId: p(n), platform: "telegram" });
    let inFlight = 0;
    let peak = 0;
    const runner: PlatformSyncRunner = {
      platform: "telegram",
      run: async (_job, lease) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return lease.commit(() => Promise.resolve({ status: "success" }));
      },
    };
    const s = createScheduler(deps(db), [runner], {
      tickMs: 10,
      batchSize: 10,
      leaseMs: 60_000,
      concurrency: 1,
    });
    s.start();
    await new Promise((r) => setTimeout(r, 400));
    await s.stop();
    assertEquals(peak, 1);
    for (const n of [1, 2, 3]) assertEquals((await listRunsForPost(db, p(n))).length >= 1, true);
  });
});

Deno.test("a job for a platform without a runner is failed and released", async () => {
  await withDb(async (db) => {
    await ensureActiveJob(db, { postId: p(1), platform: "telegram" });
    const s = createScheduler(deps(db), [], {
      tickMs: 10_000,
      batchSize: 10,
      leaseMs: 60_000,
      concurrency: 5,
    });
    await s.tick();
    await s.stop();
    const [run] = await listRunsForPost(db, p(1));
    assertEquals(run?.status, "failure");
    assertEquals(run?.error, "no runner for platform telegram");
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `deno test -A src/sync/tests/run_test.ts src/sync/tests/scheduler_test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/sync/runner.ts`**

```ts
import type { Tx } from "../db/client.ts";
import type { PickedJob } from "./models/jobs.ts";
import type { Platform } from "./models/schema.ts";

export type RunOutcome =
  | { status: "success" }
  | { status: "failure"; error: string; disable: boolean };

export class LeaseLost extends Error {
  constructor() {
    super("lease lost");
  }
}

export interface Lease {
  readonly token: string;
  commit(fn: (tx: Tx) => Promise<RunOutcome>): Promise<RunOutcome>;
}

/** One per platform. Fetches one page for the job and writes it inside `lease.commit`. */
export interface PlatformSyncRunner {
  readonly platform: Platform;
  run(job: PickedJob, lease: Lease): Promise<RunOutcome>;
}
```

- [ ] **Step 5: Write `src/sync/run.ts`**

```ts
import type { Deps } from "../deps.ts";
import { fenceJob, heartbeatJob, type PickedJob, releaseJob } from "./models/jobs.ts";
import { closeRun, openRun } from "./models/runs.ts";
import { type Lease, LeaseLost, type PlatformSyncRunner, type RunOutcome } from "./runner.ts";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runJob(
  deps: Deps,
  runner: PlatformSyncRunner,
  job: PickedJob,
  leaseMs: number,
): Promise<RunOutcome> {
  const runId = await openRun(deps.db, {
    jobId: job.id,
    postId: job.postId,
    platform: job.platform,
    startedAt: deps.now(),
  });

  let lost = false;
  let committed = false;
  const beat = setInterval(() => {
    heartbeatJob(deps.db, job.id, job.leaseToken, leaseMs)
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch((e: unknown) => {
        console.error(`heartbeat for job ${job.id} failed:`, e);
      });
  }, Math.max(1, Math.floor(leaseMs / 2)));

  const lease: Lease = {
    token: job.leaseToken,
    commit: (fn) =>
      deps.db.transaction(async (tx) => {
        const held = await fenceJob(tx, job.id, job.leaseToken);
        if (!held) throw new LeaseLost();
        const outcome = await fn(tx);
        await closeRun(tx, runId, {
          finishedAt: deps.now(),
          status: outcome.status,
          error: outcome.status === "failure" ? outcome.error : null,
        });
        await releaseJob(tx, job.id, job.leaseToken, {
          disable: outcome.status === "failure" && outcome.disable,
        });
        committed = true;
        return outcome;
      }),
  };

  try {
    return await runner.run(job, lease);
  } catch (e: unknown) {
    if (e instanceof LeaseLost || lost) {
      const outcome: RunOutcome = { status: "failure", error: "lease lost", disable: false };
      await closeRun(deps.db, runId, { finishedAt: deps.now(), status: "failure", error: "lease lost" });
      return outcome;
    }
    const outcome: RunOutcome = { status: "failure", error: errorMessage(e), disable: false };
    if (!committed) {
      try {
        await lease.commit(() => Promise.resolve(outcome));
      } catch (inner: unknown) {
        if (!(inner instanceof LeaseLost)) throw inner;
        await closeRun(deps.db, runId, { finishedAt: deps.now(), status: "failure", error: "lease lost" });
        return { status: "failure", error: "lease lost", disable: false };
      }
    }
    return outcome;
  } finally {
    clearInterval(beat);
  }
}
```

- [ ] **Step 6: Write `src/sync/scheduler.ts`**

```ts
import type { Deps } from "../deps.ts";
import { type PickedJob, pickJobs, releaseJob } from "./models/jobs.ts";
import { closeRun, openRun } from "./models/runs.ts";
import { runJob } from "./run.ts";
import type { PlatformSyncRunner } from "./runner.ts";
import type { Platform } from "./models/schema.ts";

export interface SchedulerOptions {
  tickMs: number;
  batchSize: number;
  leaseMs: number;
  concurrency: number;
}

export interface Scheduler {
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createScheduler(
  deps: Deps,
  runners: PlatformSyncRunner[],
  options: SchedulerOptions,
): Scheduler {
  const byPlatform = new Map<Platform, PlatformSyncRunner>(runners.map((r) => [r.platform, r]));
  const inFlight = new Set<Promise<void>>();
  let timer: number | null = null;

  async function noRunner(job: PickedJob): Promise<void> {
    const error = `no runner for platform ${job.platform}`;
    const runId = await openRun(deps.db, {
      jobId: job.id,
      postId: job.postId,
      platform: job.platform,
      startedAt: deps.now(),
    });
    await closeRun(deps.db, runId, { finishedAt: deps.now(), status: "failure", error });
    await releaseJob(deps.db, job.id, job.leaseToken, { disable: false });
  }

  function launch(job: PickedJob): void {
    const runner = byPlatform.get(job.platform);
    const work = (runner === undefined
      ? noRunner(job)
      : runJob(deps, runner, job, options.leaseMs).then(() => undefined))
      .catch((e: unknown) => {
        console.error(`run for job ${job.id} crashed:`, e);
      });
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }

  async function tick(): Promise<void> {
    const room = options.concurrency - inFlight.size;
    if (room <= 0) return;
    const jobs = await pickJobs(deps.db, {
      batchSize: Math.min(options.batchSize, room),
      leaseMs: options.leaseMs,
    });
    for (const job of jobs) launch(job);
  }

  return {
    tick,
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        tick().catch((e: unknown) => {
          console.error("scheduler tick failed:", e);
        });
      }, options.tickMs);
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await Promise.all([...inFlight]);
    },
  };
}
```

- [ ] **Step 7: Run the tests**

Run: `deno test -A src/sync/`
Expected: PASS. The heartbeat test takes about half a second.

- [ ] **Step 8: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/sync
git commit -m "Add fenced run, heartbeat and scheduler loop"
```

---

### Task 7: Telegram post model

**Files:**
- Create: `src/telegram/models/posts.ts`, `src/telegram/tests/posts_model_test.ts`

**Interfaces:**
- Consumes: `telegramPosts` (Task 2), `Executor`.
- Produces:

```ts
export type PostRow = typeof telegramPosts.$inferSelect;
export interface NewPost {
  username: string; title: string; url: string; postType: PostType;
  messageId: number; channelId: number; forumTopicId: number | null;
  discussionChatId: number | null; discussionMessageId: number | null;
}
export function upsertPost(ex, input: NewPost): Promise<{ post: PostRow; created: boolean }>
export function getPost(ex, id: string): Promise<PostRow | null>
export function softDeletePost(ex, id: string, at: Date): Promise<PostRow | null>
export function markSyncSuccess(ex, postId, input: { lastSyncedMessageId: number | null; at: Date }): Promise<void>
export function markSyncFailure(ex, postId, error: string, at: Date): Promise<void>
export interface ThreadCoordinates { chatId: number; rootMessageId: number; topicId: number | null }
export function threadCoordinates(post: PostRow): ThreadCoordinates
```

- [ ] **Step 1: Write the failing tests `src/telegram/tests/posts_model_test.ts`**

```ts
import { assert, assertEquals, assertThrows } from "@std/assert";
import { withDb } from "../../db/tests/helpers.ts";
import {
  getPost,
  markSyncFailure,
  markSyncSuccess,
  type NewPost,
  softDeletePost,
  threadCoordinates,
  upsertPost,
} from "../models/posts.ts";

const channelPost: NewPost = {
  username: "alice",
  title: "Hello",
  url: "https://t.me/mychannel/5",
  postType: "channel",
  messageId: 5,
  channelId: 100,
  forumTopicId: null,
  discussionChatId: 200,
  discussionMessageId: 50,
};

Deno.test("upsertPost creates, then restores on conflict without rewriting the thread", async () => {
  await withDb(async (db) => {
    const first = await upsertPost(db, channelPost);
    assertEquals(first.created, true);
    await softDeletePost(db, first.post.id, new Date());
    await markSyncFailure(db, first.post.id, "boom", new Date());
    const second = await upsertPost(db, {
      ...channelPost,
      title: "Renamed",
      url: "tg://resolve?domain=mychannel&post=5",
      discussionChatId: 999,
      discussionMessageId: 999,
    });
    assertEquals(second.created, false);
    assertEquals(second.post.id, first.post.id);
    assertEquals(second.post.deletedAt, null);
    assertEquals(second.post.syncError, null);
    assertEquals(second.post.discussionChatId, 200, "thread coordinates are fixed at publish");
    assertEquals(second.post.title, "Hello", "existing attributes are kept");
    const other = await upsertPost(db, { ...channelPost, username: "bob" });
    assertEquals(other.created, true);
  });
});

Deno.test("softDeletePost sets deleted_at once and returns the row; unknown id is null", async () => {
  await withDb(async (db) => {
    const { post } = await upsertPost(db, channelPost);
    const t1 = new Date("2026-01-01T00:00:00Z");
    const a = await softDeletePost(db, post.id, t1);
    const b = await softDeletePost(db, post.id, new Date("2026-02-01T00:00:00Z"));
    assertEquals(a?.deletedAt?.toISOString(), t1.toISOString());
    assertEquals(b?.deletedAt?.toISOString(), t1.toISOString());
    assertEquals(await softDeletePost(db, "0199a000-0000-7000-8000-000000000001", t1), null);
    assertEquals(await getPost(db, "0199a000-0000-7000-8000-000000000001"), null);
  });
});

Deno.test("sync marks: success moves the mark and clears the error; empty page keeps the mark", async () => {
  await withDb(async (db) => {
    const { post } = await upsertPost(db, channelPost);
    await markSyncFailure(db, post.id, "flood_wait: 30", new Date());
    assertEquals((await getPost(db, post.id))?.syncError, "flood_wait: 30");
    const at = new Date("2026-01-01T00:00:00Z");
    await markSyncSuccess(db, post.id, { lastSyncedMessageId: 77, at });
    let row = await getPost(db, post.id);
    assertEquals(row?.lastSyncedMessageId, 77);
    assertEquals(row?.syncError, null);
    assertEquals(row?.lastSyncedAt?.toISOString(), at.toISOString());
    await markSyncSuccess(db, post.id, { lastSyncedMessageId: null, at: new Date() });
    row = await getPost(db, post.id);
    assertEquals(row?.lastSyncedMessageId, 77);
  });
});

Deno.test("threadCoordinates by post type", async () => {
  await withDb(async (db) => {
    const { post: channel } = await upsertPost(db, channelPost);
    assertEquals(threadCoordinates(channel), { chatId: 200, rootMessageId: 50, topicId: null });
    const { post: group } = await upsertPost(db, {
      ...channelPost,
      postType: "supergroup",
      channelId: 300,
      messageId: 7,
      discussionChatId: null,
      discussionMessageId: null,
    });
    assertEquals(threadCoordinates(group), { chatId: 300, rootMessageId: 7, topicId: null });
    const { post: forum } = await upsertPost(db, {
      ...channelPost,
      postType: "forum",
      channelId: 400,
      messageId: 9,
      forumTopicId: 9,
      discussionChatId: null,
      discussionMessageId: null,
    });
    assertEquals(threadCoordinates(forum), { chatId: 400, rootMessageId: 9, topicId: 9 });
    assertThrows(() => threadCoordinates({ ...channel, discussionChatId: null }));
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `deno test -A src/telegram/tests/posts_model_test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/telegram/models/posts.ts`**

```ts
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { type PostType, telegramPosts } from "./schema.ts";

export type PostRow = typeof telegramPosts.$inferSelect;

export interface NewPost {
  username: string;
  title: string;
  url: string;
  postType: PostType;
  messageId: number;
  channelId: number;
  forumTopicId: number | null;
  discussionChatId: number | null;
  discussionMessageId: number | null;
}

export interface ThreadCoordinates {
  chatId: number;
  rootMessageId: number;
  topicId: number | null;
}

/**
 * Insert, or on (username, channel_id, message_id) restore: clear deleted_at and sync_error.
 * Nothing else is rewritten; the thread is fixed when the post is published.
 */
export async function upsertPost(
  ex: Executor,
  input: NewPost,
): Promise<{ post: PostRow; created: boolean }> {
  const rows = await ex
    .insert(telegramPosts)
    .values(input)
    .onConflictDoUpdate({
      target: [telegramPosts.username, telegramPosts.channelId, telegramPosts.messageId],
      set: { deletedAt: null, syncError: null, updatedAt: sql`now()` },
    })
    .returning({ ...getTableColumns(telegramPosts), created: sql<boolean>`(xmax = 0)` });
  const row = rows[0];
  if (row === undefined) throw new Error("upsertPost returned no row");
  const { created, ...post } = row;
  return { post, created };
}

export async function getPost(ex: Executor, id: string): Promise<PostRow | null> {
  const rows = await ex.select().from(telegramPosts).where(eq(telegramPosts.id, id));
  return rows[0] ?? null;
}

export async function softDeletePost(ex: Executor, id: string, at: Date): Promise<PostRow | null> {
  const rows = await ex
    .update(telegramPosts)
    .set({ deletedAt: sql`coalesce(${telegramPosts.deletedAt}, ${at})`, updatedAt: sql`now()` })
    .where(eq(telegramPosts.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function markSyncSuccess(
  ex: Executor,
  postId: string,
  input: { lastSyncedMessageId: number | null; at: Date },
): Promise<void> {
  await ex
    .update(telegramPosts)
    .set({
      lastSyncedAt: input.at,
      lastSyncedMessageId: input.lastSyncedMessageId === null
        ? telegramPosts.lastSyncedMessageId
        : input.lastSyncedMessageId,
      syncError: null,
      updatedAt: sql`now()`,
    })
    .where(eq(telegramPosts.id, postId));
}

export async function markSyncFailure(
  ex: Executor,
  postId: string,
  error: string,
  at: Date,
): Promise<void> {
  await ex
    .update(telegramPosts)
    .set({ syncError: error, updatedAt: at })
    .where(eq(telegramPosts.id, postId));
}

export function threadCoordinates(post: PostRow): ThreadCoordinates {
  switch (post.postType) {
    case "channel": {
      if (post.discussionChatId === null || post.discussionMessageId === null) {
        throw new Error(`channel post ${post.id} has no discussion thread stored`);
      }
      return { chatId: post.discussionChatId, rootMessageId: post.discussionMessageId, topicId: null };
    }
    case "supergroup":
      return { chatId: post.channelId, rootMessageId: post.messageId, topicId: null };
    case "forum": {
      if (post.forumTopicId === null) {
        throw new Error(`forum post ${post.id} has no topic id stored`);
      }
      return { chatId: post.channelId, rootMessageId: post.forumTopicId, topicId: post.forumTopicId };
    }
  }
}
```

If passing a column (`telegramPosts.lastSyncedMessageId`) inside `.set()` is rejected by types, use `sql\`${telegramPosts.lastSyncedMessageId}\`` for the "unchanged" branch. If the `${at}` Date parameter inside `coalesce` is sent as text and PostgreSQL complains, cast: `sql\`coalesce(${telegramPosts.deletedAt}, ${at.toISOString()}::timestamptz)\``.

- [ ] **Step 4: Run the tests**

Run: `deno test -A src/telegram/tests/posts_model_test.ts`
Expected: PASS (four tests).

- [ ] **Step 5: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/telegram/models/posts.ts src/telegram/tests/posts_model_test.ts
git commit -m "Add Telegram post model with restore-on-conflict and thread coordinates"
```

---

### Task 8: Telegram comment model

**Files:**
- Create: `src/telegram/models/comments.ts`, `src/telegram/tests/comments_model_test.ts`

**Interfaces:**
- Consumes: `telegramComments` (Task 2), `Message` (Task 3), `upsertPost` (Task 7, tests only).
- Produces:

```ts
export type CommentRow = typeof telegramComments.$inferSelect;
export interface CommentItem extends CommentRow { hasReplies: boolean }
export interface NewComment {
  postId: string; telegramMessageId: number; replyToMessageId: number; replyTo: string | null;
  authorId: number | null; authorUsername: string | null; authorName: string | null;
  text: string; postedAt: Date; editedAt: Date | null;
}
export function insertFromMessages(ex, postId: string, messages: Message[]): Promise<void>
export function insertReply(ex, input: NewComment): Promise<CommentRow>   // existing row on conflict
export function getComment(ex, key: { id: string; postId: string }): Promise<CommentRow | null>
export function listTopLevel(ex, postId: string, page: { limit: number; after: string | null }): Promise<CommentItem[]>  // fetches limit + 1
export function listReplies(ex, commentId: string, page: { limit: number; after: string | null }): Promise<CommentItem[]>  // fetches limit + 1
export function markDeleted(ex, id: string, at: Date): Promise<CommentRow>
export function refreshFromMessage(ex, id: string, input: { text: string; editedAt: Date | null }): Promise<CommentRow>
export function withHasReplies(ex, row: CommentRow): Promise<CommentItem>
```

- [ ] **Step 1: Write the failing tests `src/telegram/tests/comments_model_test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import { withDb } from "../../db/tests/helpers.ts";
import type { Db } from "../../db/client.ts";
import type { Message } from "../client/types.ts";
import {
  getComment,
  insertFromMessages,
  insertReply,
  listReplies,
  listTopLevel,
  markDeleted,
  refreshFromMessage,
  withHasReplies,
} from "../models/comments.ts";
import { upsertPost } from "../models/posts.ts";

const ROOT = 50;

function msg(id: number, replyTo: number, text = `m${String(id)}`): Message {
  return {
    kind: "message",
    id,
    replyToMessageId: replyTo,
    author: { id: 1000 + id, username: `u${String(id)}`, name: `User ${String(id)}` },
    text,
    postedAt: new Date(2026, 0, 1, 0, 0, id),
    editedAt: null,
  };
}

async function post(db: Db, username = "alice"): Promise<string> {
  const { post } = await upsertPost(db, {
    username,
    title: "t",
    url: "https://t.me/c/100/5",
    postType: "channel",
    messageId: 5,
    channelId: 100,
    forumTopicId: null,
    discussionChatId: 200,
    discussionMessageId: ROOT,
  });
  return post.id;
}

Deno.test("insertFromMessages stores new rows, resolves reply_to, ignores known ids", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    await insertFromMessages(db, postId, [msg(51, ROOT), msg(52, 51), msg(53, 49)]);
    const top = await listTopLevel(db, postId, { limit: 10, after: null });
    assertEquals(top.map((c) => c.telegramMessageId), [51, 53], "parent never ingested lists top-level");
    assertEquals(top[0]?.hasReplies, true);
    assertEquals(top[1]?.hasReplies, false);
    assertEquals(top[0]?.authorId, 1051);
    assertEquals(top[0]?.authorUsername, "u51");
    const [reply] = await listReplies(db, top[0]?.id ?? "", { limit: 10, after: null });
    assertEquals(reply?.telegramMessageId, 52);
    assertEquals(reply?.replyToMessageId, 51);
    await insertFromMessages(db, postId, [msg(51, ROOT, "changed"), msg(54, 52)]);
    const again = await listTopLevel(db, postId, { limit: 10, after: null });
    assertEquals(again[0]?.text, "m51", "known rows are left as they are");
    const nested = await listReplies(db, reply?.id ?? "", { limit: 10, after: null });
    assertEquals(nested.map((c) => c.telegramMessageId), [54], "parent from an earlier page");
  });
});

Deno.test("anonymous messages store null author fields", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    await insertFromMessages(db, postId, [{ ...msg(51, ROOT), author: null }]);
    const [row] = await listTopLevel(db, postId, { limit: 10, after: null });
    assertEquals(row?.authorId, null);
    assertEquals(row?.authorName, null);
  });
});

Deno.test("insertReply returns the existing row when the sync got there first", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    await insertFromMessages(db, postId, [msg(51, ROOT)]);
    const [parent] = await listTopLevel(db, postId, { limit: 10, after: null });
    assert(parent !== undefined);
    const input = {
      postId,
      telegramMessageId: 60,
      replyToMessageId: 51,
      replyTo: parent.id,
      authorId: 1,
      authorUsername: "alice",
      authorName: "Alice",
      text: "thanks",
      postedAt: new Date(),
      editedAt: null,
    };
    const a = await insertReply(db, input);
    const b = await insertReply(db, { ...input, text: "other" });
    assertEquals(a.id, b.id);
    assertEquals(b.text, "thanks");
    await insertFromMessages(db, postId, [msg(60, 51, "from sync")]);
    const [again] = await listReplies(db, parent.id, { limit: 10, after: null });
    assertEquals(again?.text, "thanks", "the sync skips the row the reply wrote");
  });
});

Deno.test("listings page by id ascending and fetch one extra row", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    await insertFromMessages(db, postId, [msg(51, ROOT), msg(52, ROOT), msg(53, ROOT), msg(54, 51)]);
    const first = await listTopLevel(db, postId, { limit: 2, after: null });
    assertEquals(first.length, 3, "limit + 1");
    const after = first[1]?.id ?? "";
    const second = await listTopLevel(db, postId, { limit: 2, after });
    assertEquals(second.map((c) => c.telegramMessageId), [53]);
    const other = await post(db, "bob");
    assertEquals((await listTopLevel(db, other, { limit: 10, after: null })).length, 0);
  });
});

Deno.test("getComment is scoped by post; markDeleted and refreshFromMessage update the row", async () => {
  await withDb(async (db) => {
    const postId = await post(db);
    const other = await post(db, "bob");
    await insertFromMessages(db, postId, [msg(51, ROOT)]);
    const [row] = await listTopLevel(db, postId, { limit: 10, after: null });
    assert(row !== undefined);
    assertEquals((await getComment(db, { id: row.id, postId }))?.id, row.id);
    assertEquals(await getComment(db, { id: row.id, postId: other }), null);
    const edited = await refreshFromMessage(db, row.id, {
      text: "new",
      editedAt: new Date("2026-01-02T08:00:00Z"),
    });
    assertEquals(edited.text, "new");
    assertEquals(edited.editedAt?.toISOString(), "2026-01-02T08:00:00.000Z");
    const gone = await markDeleted(db, row.id, new Date("2026-01-03T00:00:00Z"));
    assertEquals(gone.deletedAt?.toISOString(), "2026-01-03T00:00:00.000Z");
    const item = await withHasReplies(db, gone);
    assertEquals(item.hasReplies, false);
    const still = await listTopLevel(db, postId, { limit: 10, after: null });
    assertEquals(still.length, 1, "deleted rows still list");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `deno test -A src/telegram/tests/comments_model_test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/telegram/models/comments.ts`**

```ts
import { and, asc, eq, exists, gt, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Executor } from "../../db/client.ts";
import type { Message } from "../client/types.ts";
import { telegramComments } from "./schema.ts";

export type CommentRow = typeof telegramComments.$inferSelect;

export interface CommentItem extends CommentRow {
  hasReplies: boolean;
}

export interface NewComment {
  postId: string;
  telegramMessageId: number;
  replyToMessageId: number;
  replyTo: string | null;
  authorId: number | null;
  authorUsername: string | null;
  authorName: string | null;
  text: string;
  postedAt: Date;
  editedAt: Date | null;
}

export interface PageArgs {
  limit: number;
  after: string | null;
}

const replies = alias(telegramComments, "r");

function hasRepliesExpr() {
  return exists(
    sql`(select 1 from ${replies} where ${replies.replyTo} = ${telegramComments.id})`,
  );
}

function selectItems() {
  return {
    id: telegramComments.id,
    postId: telegramComments.postId,
    telegramMessageId: telegramComments.telegramMessageId,
    replyToMessageId: telegramComments.replyToMessageId,
    replyTo: telegramComments.replyTo,
    authorId: telegramComments.authorId,
    authorUsername: telegramComments.authorUsername,
    authorName: telegramComments.authorName,
    text: telegramComments.text,
    postedAt: telegramComments.postedAt,
    editedAt: telegramComments.editedAt,
    deletedAt: telegramComments.deletedAt,
    createdAt: telegramComments.createdAt,
    updatedAt: telegramComments.updatedAt,
    hasReplies: sql<boolean>`${hasRepliesExpr()}`,
  };
}

/**
 * Sync step 3: insert the page with `on conflict do nothing`, then set reply_to on the new rows
 * by joining reply_to_message_id to the post's comments. The thread root is not a comment row,
 * so top-level comments stay null, as does a reply whose parent never came through.
 */
export async function insertFromMessages(
  ex: Executor,
  postId: string,
  messages: Message[],
): Promise<void> {
  if (messages.length === 0) return;
  await ex
    .insert(telegramComments)
    .values(
      messages.map((m) => ({
        postId,
        telegramMessageId: m.id,
        replyToMessageId: m.replyToMessageId,
        replyTo: null,
        authorId: m.author?.id ?? null,
        authorUsername: m.author?.username ?? null,
        authorName: m.author?.name ?? null,
        text: m.text,
        postedAt: m.postedAt,
        editedAt: m.editedAt,
      })),
    )
    .onConflictDoNothing({
      target: [telegramComments.postId, telegramComments.telegramMessageId],
    });
  const ids = messages.map((m) => m.id);
  await ex.execute(sql`
    update telegram_comments c
      set reply_to = p.id
    from telegram_comments p
    where c.post_id = ${postId}
      and p.post_id = ${postId}
      and c.reply_to is null
      and c.telegram_message_id in ${ids}
      and p.telegram_message_id = c.reply_to_message_id
  `);
}

/** Reply step 5: insert the sent reply; on conflict the sync's row is complete, so use it. */
export async function insertReply(ex: Executor, input: NewComment): Promise<CommentRow> {
  const inserted = await ex
    .insert(telegramComments)
    .values(input)
    .onConflictDoNothing({
      target: [telegramComments.postId, telegramComments.telegramMessageId],
    })
    .returning();
  const row = inserted[0];
  if (row !== undefined) return row;
  const existing = await ex
    .select()
    .from(telegramComments)
    .where(
      and(
        eq(telegramComments.postId, input.postId),
        eq(telegramComments.telegramMessageId, input.telegramMessageId),
      ),
    );
  const found = existing[0];
  if (found === undefined) throw new Error("insertReply: conflict row vanished");
  return found;
}

export async function getComment(
  ex: Executor,
  key: { id: string; postId: string },
): Promise<CommentRow | null> {
  const rows = await ex
    .select()
    .from(telegramComments)
    .where(and(eq(telegramComments.id, key.id), eq(telegramComments.postId, key.postId)));
  return rows[0] ?? null;
}

/** Top-level rows of a post, paged by id through the (post_id, id) partial index. Fetches limit + 1. */
export function listTopLevel(ex: Executor, postId: string, page: PageArgs): Promise<CommentItem[]> {
  const where = [eq(telegramComments.postId, postId), isNull(telegramComments.replyTo)];
  if (page.after !== null) where.push(gt(telegramComments.id, page.after));
  return ex
    .select(selectItems())
    .from(telegramComments)
    .where(and(...where))
    .orderBy(asc(telegramComments.id))
    .limit(page.limit + 1);
}

/** Direct children of a comment, paged by id through the (reply_to, id) partial index. Fetches limit + 1. */
export function listReplies(ex: Executor, commentId: string, page: PageArgs): Promise<CommentItem[]> {
  const where = [eq(telegramComments.replyTo, commentId)];
  if (page.after !== null) where.push(gt(telegramComments.id, page.after));
  return ex
    .select(selectItems())
    .from(telegramComments)
    .where(and(...where))
    .orderBy(asc(telegramComments.id))
    .limit(page.limit + 1);
}

export async function markDeleted(ex: Executor, id: string, at: Date): Promise<CommentRow> {
  const rows = await ex
    .update(telegramComments)
    .set({ deletedAt: sql`coalesce(${telegramComments.deletedAt}, ${at})`, updatedAt: at })
    .where(eq(telegramComments.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`comment ${id} not found`);
  return row;
}

export async function refreshFromMessage(
  ex: Executor,
  id: string,
  input: { text: string; editedAt: Date | null },
): Promise<CommentRow> {
  const rows = await ex
    .update(telegramComments)
    .set({ text: input.text, editedAt: input.editedAt, updatedAt: sql`now()` })
    .where(eq(telegramComments.id, id))
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error(`comment ${id} not found`);
  return row;
}

export async function withHasReplies(ex: Executor, row: CommentRow): Promise<CommentItem> {
  const rows = await ex
    .select({ id: replies.id })
    .from(replies)
    .where(eq(replies.replyTo, row.id))
    .limit(1);
  return { ...row, hasReplies: rows.length > 0 };
}
```

Notes for the implementer: `inArray` is imported for the case you prefer `inArray(telegramComments.telegramMessageId, ids)` in a drizzle update-with-join; the raw `update ... from` above is the simplest form, and `${ids}` renders as a parameter list in drizzle's `sql` (if it renders as an array literal instead, use `= any(${ids})`). Drop the unused import before linting. The `hasReplies` select column may need `.mapWith(Boolean)` if the driver returns `t`/`f` strings.

- [ ] **Step 4: Run the tests**

Run: `deno test -A src/telegram/tests/comments_model_test.ts`
Expected: PASS (five tests).

- [ ] **Step 5: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/telegram/models/comments.ts src/telegram/tests/comments_model_test.ts
git commit -m "Add Telegram comment model: page ingest, reply insert, id-paged listings"
```

---

### Task 9: Post handlers: url parser, submit, get, delete, submit error switch

**Files:**
- Create: `src/telegram/api/errors.ts`, `src/telegram/api/handlers/posts.ts`, `src/telegram/tests/post_url_test.ts`, `src/telegram/tests/posts_handlers_test.ts`

**Interfaces:**
- Consumes: `Deps`; `FakeTelegram`; `upsertPost/getPost/softDeletePost` (Task 7); `ensureActiveJob/setJobActive/getJobByPost` (Task 5); `HttpError`.
- Produces:

```ts
// src/telegram/api/errors.ts
export function translateSubmitError(e: unknown, ctx: { username: string }): never   // rethrows non-Telegram errors
export function translateReplyError(e: unknown, ctx: { username: string; commentId: string }): never
export function translateSyncError(e: unknown): { error: string; disable: boolean }  // rethrows non-Telegram errors

// src/telegram/api/handlers/posts.ts
export interface ParsedPostUrl { ref: string | number; messageId: number; topicId: number | null }
export function parsePostUrl(url: string): ParsedPostUrl                // throws HttpError 400 malformed_url
export const submitBodySchema: z.ZodType<{ title: string; username: string; url: string }>
export interface SubmitResult { status: 200 | 201; id: string; created_at: string }
export function submitPost(deps: Deps, body: SubmitBody): Promise<SubmitResult>
export interface PostView { status: 200; id; username; title; url; comments_synced_at: string | null; sync_error: string | null; comment_sync_enabled: boolean; created_at: string; deleted_at: string | null }
export function getPostView(deps: Deps, id: string): Promise<PostView>  // 404 post_not_found
export function deletePost(deps: Deps, id: string): Promise<{ status: 200; id: string; deleted_at: string }>
```

- [ ] **Step 1: Write the failing url tests `src/telegram/tests/post_url_test.ts`**

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { HttpError } from "../../api/errors.ts";
import { parsePostUrl } from "../api/handlers/posts.ts";

Deno.test("supported url forms", () => {
  assertEquals(parsePostUrl("https://t.me/durov/123"), { ref: "durov", messageId: 123, topicId: null });
  assertEquals(parsePostUrl("t.me/durov/123"), { ref: "durov", messageId: 123, topicId: null });
  assertEquals(parsePostUrl("https://t.me/durov/123?single"), { ref: "durov", messageId: 123, topicId: null });
  assertEquals(parsePostUrl("https://t.me/c/1234567/89"), { ref: 1234567, messageId: 89, topicId: null });
  assertEquals(parsePostUrl("https://t.me/c/-1001234567/89"), { ref: 1234567, messageId: 89, topicId: null });
  assertEquals(parsePostUrl("https://t.me/myforum/42/42"), { ref: "myforum", messageId: 42, topicId: 42 });
  assertEquals(parsePostUrl("https://t.me/c/555/7/7"), { ref: 555, messageId: 7, topicId: 7 });
  assertEquals(parsePostUrl("tg://resolve?domain=durov&post=123"), { ref: "durov", messageId: 123, topicId: null });
  assertEquals(parsePostUrl("tg://privatepost?channel=1234567&post=89"), { ref: 1234567, messageId: 89, topicId: null });
  assertEquals(parsePostUrl("tg://privatepost?channel=-1001234567&post=89"), { ref: 1234567, messageId: 89, topicId: null });
});

function malformed(url: string, message: string): void {
  const err = assertThrows(() => parsePostUrl(url), HttpError);
  assertEquals(err.status, 400);
  assertEquals(err.code, "malformed_url");
  assertEquals(err.message, message);
}

Deno.test("unsupported forms are 400 malformed_url", () => {
  malformed("https://example.com/durov/123", "url does not match any supported form");
  malformed("https://t.me/durov", "url does not match any supported form");
  malformed("https://t.me/durov/abc", "url does not match any supported form");
  malformed("not a url", "url does not match any supported form");
  malformed("tg://resolve?domain=durov", "url does not match any supported form");
  malformed("https://t.me/durov/123?comment=5", "links to a specific comment are not supported");
  malformed("tg://resolve?domain=durov&post=123&comment=5", "links to a specific comment are not supported");
  malformed("https://t.me/myforum/42/43", "forum link must point at the topic root");
  malformed("https://t.me/c/555/7/8", "forum link must point at the topic root");
});
```

- [ ] **Step 2: Write the failing handler tests `src/telegram/tests/posts_handlers_test.ts`**

```ts
import { assert, assertEquals, assertRejects } from "@std/assert";
import { HttpError } from "../../api/errors.ts";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import type { Deps } from "../../deps.ts";
import { getJobByPost } from "../../sync/models/jobs.ts";
import { FloodWait, SessionInvalid, Upstream } from "../client/errors.ts";
import { FakeTelegram } from "../client/fake.ts";
import { deletePost, getPostView, submitPost } from "../api/handlers/posts.ts";
import { getPost, markSyncFailure } from "../models/posts.ts";

function world(db: Db): { deps: Deps; fake: FakeTelegram } {
  const fake = new FakeTelegram();
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.addPeer(100, { chatId: 100, kind: "channel" });
  fake.linkDiscussion(100, 5, { chatId: 200, rootMessageId: 50 });
  fake.addPeer("lonely", { chatId: 300, kind: "channel" });
  fake.addPeer("mygroup", { chatId: 400, kind: "supergroup" });
  fake.addPeer("myforum", { chatId: 500, kind: "forum" });
  const deps: Deps = {
    db,
    telegram: (u) => fake.forUser(u),
    now: () => new Date("2026-01-01T10:15:30Z"),
  };
  return { deps, fake };
}

async function expectHttp(p: Promise<unknown>, status: number, code: string): Promise<HttpError> {
  const err = await assertRejects(() => p, HttpError);
  assertEquals([err.status, err.code], [status, code]);
  return err;
}

Deno.test("submit a channel post: 201, thread resolved, job active; resubmit: 200", async () => {
  await withDb(async (db) => {
    const { deps } = world(db);
    const body = { title: "My post", username: "alice", url: "https://t.me/mychannel/5" };
    const created = await submitPost(deps, body);
    assertEquals(created.status, 201);
    const post = await getPost(db, created.id);
    assertEquals(post?.postType, "channel");
    assertEquals(post?.channelId, 100);
    assertEquals(post?.discussionChatId, 200);
    assertEquals(post?.discussionMessageId, 50);
    assertEquals(post?.forumTopicId, null);
    assertEquals((await getJobByPost(db, { postId: created.id, platform: "telegram" }))?.isActive, true);
    const again = await submitPost(deps, { ...body, url: "https://t.me/c/100/5" });
    assertEquals(again.status, 200);
    assertEquals(again.id, created.id, "url forms of the same post collapse");
  });
});

Deno.test("resubmitting a deleted post restores it and re-enables the job", async () => {
  await withDb(async (db) => {
    const { deps } = world(db);
    const body = { title: "My post", username: "alice", url: "https://t.me/mychannel/5" };
    const { id } = await submitPost(deps, body);
    await deletePost(deps, id);
    await markSyncFailure(db, id, "old error", new Date());
    assertEquals((await getJobByPost(db, { postId: id, platform: "telegram" }))?.isActive, false);
    const res = await submitPost(deps, body);
    assertEquals(res.status, 200);
    const view = await getPostView(deps, id);
    assertEquals(view.deleted_at, null);
    assertEquals(view.sync_error, null);
    assertEquals(view.comment_sync_enabled, true);
  });
});

Deno.test("supergroup and forum posts store coordinates without a discussion lookup", async () => {
  await withDb(async (db) => {
    const { deps, fake } = world(db);
    const g = await submitPost(deps, { title: "g", username: "alice", url: "https://t.me/mygroup/7" });
    const group = await getPost(db, g.id);
    assertEquals([group?.postType, group?.channelId, group?.messageId, group?.forumTopicId], ["supergroup", 400, 7, null]);
    const f = await submitPost(deps, { title: "f", username: "alice", url: "https://t.me/myforum/9/9" });
    const forum = await getPost(db, f.id);
    assertEquals([forum?.postType, forum?.channelId, forum?.messageId, forum?.forumTopicId], ["forum", 500, 9, 9]);
    const t = await submitPost(deps, { title: "t", username: "alice", url: "https://t.me/mygroup/3/3" });
    assertEquals((await getPost(db, t.id))?.forumTopicId, null, "topic segment ignored for a non-forum peer");
    assert(!fake.calls.some((c) => c.startsWith("getDiscussionThread")));
  });
});

Deno.test("submit errors", async () => {
  await withDb(async (db) => {
    const { deps, fake } = world(db);
    await expectHttp(submitPost(deps, { title: "x", username: "alice", url: "nope" }), 400, "malformed_url");
    await expectHttp(submitPost(deps, { title: "x", username: "bob", url: "https://t.me/mychannel/5" }), 404, "user_not_found");
    await expectHttp(submitPost(deps, { title: "x", username: "alice", url: "https://t.me/unknown/5" }), 400, "channel_not_found");
    await expectHttp(submitPost(deps, { title: "x", username: "alice", url: "https://t.me/lonely/5" }), 400, "no_discussion_group");
    await expectHttp(submitPost(deps, { title: "x", username: "alice", url: "https://t.me/mychannel/6" }), 400, "message_not_found");
    fake.failNext(new FloodWait(30));
    const flood = await expectHttp(submitPost(deps, { title: "x", username: "alice", url: "https://t.me/mychannel/5" }), 500, "flood_wait");
    assertEquals(flood.extra.retry_after, 30);
    fake.failNext(new SessionInvalid("revoked"));
    await expectHttp(submitPost(deps, { title: "x", username: "alice", url: "https://t.me/mychannel/5" }), 500, "session_invalid");
    fake.failNext(new Upstream("timeout"));
    const up = await expectHttp(submitPost(deps, { title: "x", username: "alice", url: "https://t.me/mychannel/5" }), 502, "upstream_failure");
    assertEquals(up.extra.upstream_error, "timeout");
    assertEquals(await getPost(db, "0199a000-0000-7000-8000-000000000001"), null);
  });
});

Deno.test("get and delete a post", async () => {
  await withDb(async (db) => {
    const { deps } = world(db);
    const { id } = await submitPost(deps, { title: "My post", username: "alice", url: "https://t.me/mychannel/5" });
    const view = await getPostView(deps, id);
    assertEquals(view, {
      status: 200,
      id,
      username: "alice",
      title: "My post",
      url: "https://t.me/mychannel/5",
      comments_synced_at: null,
      sync_error: null,
      comment_sync_enabled: true,
      created_at: view.created_at,
      deleted_at: null,
    });
    const del = await deletePost(deps, id);
    assertEquals(del, { status: 200, id, deleted_at: "2026-01-01T10:15:30.000Z" });
    const repeat = await deletePost(deps, id);
    assertEquals(repeat.deleted_at, del.deleted_at);
    const after = await getPostView(deps, id);
    assertEquals(after.deleted_at, del.deleted_at);
    assertEquals(after.comment_sync_enabled, false);
    await expectHttp(getPostView(deps, "0199a000-0000-7000-8000-000000000001"), 404, "post_not_found");
    await expectHttp(deletePost(deps, "0199a000-0000-7000-8000-000000000001"), 404, "post_not_found");
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `deno test -A src/telegram/tests/post_url_test.ts src/telegram/tests/posts_handlers_test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/telegram/api/errors.ts`**

```ts
import { HttpError } from "../../api/errors.ts";
import { isTelegramError } from "../client/errors.ts";

/** Submit context of the spec's error table. Non-library errors pass through. */
export function translateSubmitError(e: unknown, ctx: { username: string }): never {
  if (!isTelegramError(e)) throw e;
  switch (e.kind) {
    case "user_not_found":
      throw new HttpError(404, "user_not_found", `user ${ctx.username} not found`);
    case "peer_not_found":
      throw new HttpError(400, "channel_not_found", "url does not resolve to a channel or group");
    case "no_discussion_group":
      throw new HttpError(
        400,
        "no_discussion_group",
        "channel has no discussion group, so the post has no comment thread",
      );
    case "message_not_found":
      throw new HttpError(
        400,
        "message_not_found",
        "url does not point at a message with a discussion thread",
      );
    case "forbidden":
      throw new HttpError(502, "upstream_failure", "telegram refused the call", {
        upstream_error: e.message,
      });
    case "flood_wait":
      throw new HttpError(500, "flood_wait", `telegram asks to wait ${String(e.retryAfter)} seconds`, {
        reason: e.message,
        retry_after: e.retryAfter,
      });
    case "session_invalid":
      throw new HttpError(500, "session_invalid", `telegram session for ${ctx.username} is not valid`, {
        reason: e.message,
      });
    case "upstream":
      throw new HttpError(502, "upstream_failure", "tg api timeout", { upstream_error: e.message });
  }
}

/** Reply context. `message_not_found` is handled by the reply handler before this is reached, but is mapped for exhaustiveness. */
export function translateReplyError(e: unknown, ctx: { username: string; commentId: string }): never {
  if (!isTelegramError(e)) throw e;
  switch (e.kind) {
    case "user_not_found":
      throw new HttpError(404, "user_not_found", `user ${ctx.username} not found`);
    case "peer_not_found":
      throw new HttpError(502, "upstream_failure", "account profile could not be resolved", {
        upstream_error: e.message,
      });
    case "no_discussion_group":
      throw new HttpError(502, "upstream_failure", "unexpected library error", {
        upstream_error: e.message,
      });
    case "message_not_found":
      throw new HttpError(404, "comment_not_found", `comment ${ctx.commentId} was deleted`);
    case "forbidden":
      throw new HttpError(502, "upstream_failure", "telegram refused the reply", {
        upstream_error: e.message,
      });
    case "flood_wait":
      throw new HttpError(500, "flood_wait", `telegram asks to wait ${String(e.retryAfter)} seconds`, {
        reason: e.message,
        retry_after: e.retryAfter,
      });
    case "session_invalid":
      throw new HttpError(500, "session_invalid", `telegram session for ${ctx.username} is not valid`, {
        reason: e.message,
      });
    case "upstream":
      throw new HttpError(502, "upstream_failure", "tg api timeout", { upstream_error: e.message });
  }
}

/** Sync context: what goes into sync_error and whether the job is disabled. */
export function translateSyncError(e: unknown): { error: string; disable: boolean } {
  if (!isTelegramError(e)) throw e;
  const error = `${e.kind}: ${e.message}`;
  switch (e.kind) {
    case "user_not_found":
    case "session_invalid":
      return { error, disable: true };
    case "peer_not_found":
    case "no_discussion_group":
    case "message_not_found":
    case "forbidden":
    case "flood_wait":
    case "upstream":
      return { error, disable: false };
  }
}
```

- [ ] **Step 5: Write `src/telegram/api/handlers/posts.ts`**

```ts
import { z } from "zod";
import { HttpError } from "../../../api/errors.ts";
import type { Deps } from "../../../deps.ts";
import { ensureActiveJob, getJobByPost, setJobActive } from "../../../sync/models/jobs.ts";
import type { PeerKind } from "../../client/types.ts";
import { getPost, type PostRow, softDeletePost, upsertPost } from "../../models/posts.ts";
import { translateSubmitError } from "../errors.ts";

export interface ParsedPostUrl {
  ref: string | number;
  messageId: number;
  topicId: number | null;
}

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const DIGITS = /^\d+$/;

function malformed(message: string): HttpError {
  return new HttpError(400, "malformed_url", message);
}

function channelId(raw: string): number {
  const bare = raw.startsWith("-100") ? raw.slice(4) : raw;
  if (!DIGITS.test(bare)) throw malformed("url does not match any supported form");
  return Number(bare);
}

function messageId(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || !DIGITS.test(raw)) {
    throw malformed("url does not match any supported form");
  }
  return Number(raw);
}

function withTopic(ref: string | number, topic: string, id: string): ParsedPostUrl {
  const topicId = messageId(topic);
  const msg = messageId(id);
  if (topicId !== msg) throw malformed("forum link must point at the topic root");
  return { ref, messageId: msg, topicId };
}

function refuseCommentLink(params: URLSearchParams): void {
  if (params.has("comment")) throw malformed("links to a specific comment are not supported");
}

export function parsePostUrl(input: string): ParsedPostUrl {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw malformed("url does not match any supported form");
  }

  if (url.protocol === "tg:") {
    refuseCommentLink(url.searchParams);
    const post = url.searchParams.get("post");
    const thread = url.searchParams.get("thread");
    if (url.hostname === "resolve") {
      const domain = url.searchParams.get("domain");
      if (domain === null || !USERNAME.test(domain)) throw malformed("url does not match any supported form");
      return thread === null ? { ref: domain, messageId: messageId(post), topicId: null } : withTopic(domain, thread, post ?? "");
    }
    if (url.hostname === "privatepost") {
      const channel = url.searchParams.get("channel");
      if (channel === null) throw malformed("url does not match any supported form");
      const ref = channelId(channel);
      return thread === null ? { ref, messageId: messageId(post), topicId: null } : withTopic(ref, thread, post ?? "");
    }
    throw malformed("url does not match any supported form");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw malformed("url does not match any supported form");
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host !== "t.me" && host !== "telegram.me") throw malformed("url does not match any supported form");
  refuseCommentLink(url.searchParams);
  const segments = url.pathname.split("/").filter((s) => s !== "");

  if (segments[0] === "c") {
    const [, channel, a, b] = segments;
    if (channel === undefined || a === undefined) throw malformed("url does not match any supported form");
    const ref = channelId(channel);
    if (segments.length === 3) return { ref, messageId: messageId(a), topicId: null };
    if (segments.length === 4 && b !== undefined) return withTopic(ref, a, b);
    throw malformed("url does not match any supported form");
  }

  const [username, a, b] = segments;
  if (username === undefined || a === undefined || !USERNAME.test(username)) {
    throw malformed("url does not match any supported form");
  }
  if (segments.length === 2) return { ref: username, messageId: messageId(a), topicId: null };
  if (segments.length === 3 && b !== undefined) return withTopic(username, a, b);
  throw malformed("url does not match any supported form");
}

export const submitBodySchema = z.object({
  title: z.string().min(1),
  username: z.string().min(1),
  url: z.string().min(1),
});
export type SubmitBody = z.infer<typeof submitBodySchema>;

export interface SubmitResult {
  status: 200 | 201;
  id: string;
  created_at: string;
}

function postTypeOf(kind: PeerKind): PostRow["postType"] {
  switch (kind) {
    case "channel":
      return "channel";
    case "supergroup":
      return "supergroup";
    case "forum":
      return "forum";
  }
}

export async function submitPost(deps: Deps, body: SubmitBody): Promise<SubmitResult> {
  const parsed = parsePostUrl(body.url);

  let peerChatId: number;
  let postType: PostRow["postType"];
  let discussion: { chatId: number; rootMessageId: number } | null = null;
  try {
    const client = await deps.telegram(body.username);
    const peer = await client.resolvePeer(parsed.ref);
    peerChatId = peer.chatId;
    postType = postTypeOf(peer.kind);
    if (postType === "channel") {
      discussion = await client.getDiscussionThread(peer.chatId, parsed.messageId);
    }
  } catch (e: unknown) {
    translateSubmitError(e, { username: body.username });
  }

  const { post, created } = await deps.db.transaction(async (tx) => {
    const result = await upsertPost(tx, {
      username: body.username,
      title: body.title,
      url: body.url,
      postType,
      messageId: parsed.messageId,
      channelId: peerChatId,
      forumTopicId: postType === "forum" ? parsed.messageId : null,
      discussionChatId: discussion?.chatId ?? null,
      discussionMessageId: discussion?.rootMessageId ?? null,
    });
    await ensureActiveJob(tx, { postId: result.post.id, platform: "telegram" });
    return result;
  });

  return { status: created ? 201 : 200, id: post.id, created_at: post.createdAt.toISOString() };
}

export interface PostView {
  status: 200;
  id: string;
  username: string;
  title: string;
  url: string;
  comments_synced_at: string | null;
  sync_error: string | null;
  comment_sync_enabled: boolean;
  created_at: string;
  deleted_at: string | null;
}

export function serializePost(post: PostRow, job: { isActive: boolean } | null): PostView {
  return {
    status: 200,
    id: post.id,
    username: post.username,
    title: post.title,
    url: post.url,
    comments_synced_at: post.lastSyncedAt?.toISOString() ?? null,
    sync_error: post.syncError,
    comment_sync_enabled: job?.isActive ?? false,
    created_at: post.createdAt.toISOString(),
    deleted_at: post.deletedAt?.toISOString() ?? null,
  };
}

export async function getPostView(deps: Deps, id: string): Promise<PostView> {
  const post = await getPost(deps.db, id);
  if (post === null) throw new HttpError(404, "post_not_found", `post ${id} not found`);
  const job = await getJobByPost(deps.db, { postId: id, platform: "telegram" });
  return serializePost(post, job);
}

export async function deletePost(
  deps: Deps,
  id: string,
): Promise<{ status: 200; id: string; deleted_at: string }> {
  const deleted = await deps.db.transaction(async (tx) => {
    const post = await softDeletePost(tx, id, deps.now());
    if (post === null) return null;
    await setJobActive(tx, { postId: id, platform: "telegram" }, false);
    return post;
  });
  if (deleted?.deletedAt === null || deleted === null) {
    throw new HttpError(404, "post_not_found", `post ${id} not found`);
  }
  return { status: 200, id, deleted_at: deleted.deletedAt.toISOString() };
}
```

TypeScript may not accept `peerChatId`/`postType` as definitely assigned after the `try` because `translateSubmitError` returns `never`; if so, restructure the try block to return a tuple: `const resolved = await (async () => { try { ...; return { peerChatId, postType, discussion } } catch (e) { translateSubmitError(...) } })();`.

- [ ] **Step 6: Run the tests**

Run: `deno test -A src/telegram/tests/post_url_test.ts src/telegram/tests/posts_handlers_test.ts`
Expected: PASS.

- [ ] **Step 7: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/telegram/api src/telegram/tests/post_url_test.ts src/telegram/tests/posts_handlers_test.ts
git commit -m "Add post handlers: url parser, submit with thread resolution, get, delete"
```

---

### Task 10: Comment handlers: list, list replies, reply

**Files:**
- Create: `src/telegram/api/handlers/comments.ts`, `src/telegram/tests/comments_handlers_test.ts`
- Modify: `src/telegram/client/fake.ts` (add `failOn(callPrefix, error)`)

**Interfaces:**
- Consumes: Task 8 comment model, Task 7 `getPost`/`threadCoordinates`, `translateReplyError` (Task 9), `PageQuery`/`PageResult`/`toPage` (Task 4), `FakeTelegram`.
- Produces:

```ts
export const replyBodySchema: z.ZodType<{ text: string }>
export function validateReplyText(text: string): void            // throws 400 malformed_message / malformed_message_character
export interface CommentView { id; telegram_message_id: number; reply_to: string | null; text; author_name: string | null; author_username: string | null; author_id: string | null; has_replies: boolean; posted_at: string; edited_at: string | null; deleted_at: string | null }
export function serializeComment(c: CommentItem): CommentView
export function listComments(deps, input: { postId: string; page: PageQuery }): Promise<PageResult<CommentView>>
export function listCommentReplies(deps, input: { postId: string; commentId: string; page: PageQuery }): Promise<PageResult<CommentView>>
export function replyToComment(deps, input: { postId: string; commentId: string; text: string }): Promise<CommentView>
```

- [ ] **Step 1: Add `failOn` to the fake**

In `src/telegram/client/fake.ts`, add to `FakeTelegram`:

```ts
  private failures: { prefix: string; error: TelegramError }[] = [];

  /** The first call whose log entry starts with `prefix` throws `error` instead of running. */
  failOn(prefix: string, error: TelegramError): void {
    this.failures.push({ prefix, error });
  }
```

and change `takeFailure` to take a `call: string` argument and consult both mechanisms:

```ts
  takeFailure(call: string): TelegramError | null {
    const pending = this.pendingFailure;
    if (pending !== null) {
      this.pendingFailure = null;
      return pending;
    }
    const idx = this.failures.findIndex((f) => call.startsWith(f.prefix));
    if (idx === -1) return null;
    const [hit] = this.failures.splice(idx, 1);
    return hit?.error ?? null;
  }
```

Update the two callers (`forUser` and `FakeClient.guard`) to pass the call string they just logged. Run `deno test -A src/telegram/tests/fake_client_test.ts` to confirm nothing broke.

- [ ] **Step 2: Write the failing tests `src/telegram/tests/comments_handlers_test.ts`**

```ts
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HttpError } from "../../api/errors.ts";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import type { Deps } from "../../deps.ts";
import { Forbidden, PeerNotFound } from "../client/errors.ts";
import { FakeTelegram } from "../client/fake.ts";
import type { Message } from "../client/types.ts";
import {
  listCommentReplies,
  listComments,
  replyToComment,
  validateReplyText,
} from "../api/handlers/comments.ts";
import { deletePost, submitPost } from "../api/handlers/posts.ts";
import { insertFromMessages } from "../models/comments.ts";

const CHAT = 200;
const ROOT = 50;
const UNKNOWN = "0199a000-0000-7000-8000-000000000001";
const page10 = { limit: 10, after: null };

function msg(id: number, replyTo: number, text = `m${String(id)}`): Message {
  return {
    kind: "message",
    id,
    replyToMessageId: replyTo,
    author: { id: 1000 + id, username: `u${String(id)}`, name: `User ${String(id)}` },
    text,
    postedAt: new Date(2026, 0, 1, 0, 0, id),
    editedAt: null,
  };
}

async function world(db: Db): Promise<{ deps: Deps; fake: FakeTelegram; postId: string }> {
  const fake = new FakeTelegram();
  fake.clock = () => new Date("2026-01-01T10:15:30Z");
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.linkDiscussion(100, 5, { chatId: CHAT, rootMessageId: ROOT });
  const deps: Deps = {
    db,
    telegram: (u) => fake.forUser(u),
    now: () => new Date("2026-01-01T10:15:30Z"),
  };
  const { id } = await submitPost(deps, {
    title: "p",
    username: "alice",
    url: "https://t.me/mychannel/5",
  });
  // the same messages on Telegram and in the database, as after one sync run
  const messages = [msg(51, ROOT), msg(52, 51), msg(53, ROOT)];
  for (const m of messages) {
    fake.addMessage(CHAT, ROOT, {
      id: m.id,
      replyToMessageId: m.replyToMessageId,
      text: m.text,
      author: m.author,
      postedAt: m.postedAt,
    });
  }
  await insertFromMessages(db, id, messages);
  return { deps, fake, postId: id };
}

async function expectHttp(p: Promise<unknown>, status: number, code: string): Promise<HttpError> {
  const err = await assertRejects(() => p, HttpError);
  assertEquals([err.status, err.code], [status, code]);
  return err;
}

Deno.test("validateReplyText", () => {
  validateReplyText("fine\nwith newline\tand tab");
  let err = assertThrows(() => validateReplyText(""), HttpError);
  assertEquals([err.code, err.message], ["malformed_message", "reply text can not be empty"]);
  err = assertThrows(() => validateReplyText("   "), HttpError);
  assertEquals(err.message, "reply text can not be empty");
  err = assertThrows(() => validateReplyText("x".repeat(4097)), HttpError);
  assertEquals([err.code, err.message], ["malformed_message", "reply text is too long"]);
  err = assertThrows(() => validateReplyText("ok\u0000bad"), HttpError);
  assertEquals(err.code, "malformed_message_character");
  assertEquals(err.message, "reply text contains invalid character at 2");
  assertEquals(err.extra, { position: 2, codepoint: "U+0000" });
  err = assertThrows(() => validateReplyText("\u{1F600}\u0007"), HttpError);
  assertEquals(err.extra, { position: 1, codepoint: "U+0007" });
});

Deno.test("listComments pages top-level items with has_replies and string author ids", async () => {
  await withDb(async (db) => {
    const { deps, postId } = await world(db);
    const page1 = await listComments(deps, { postId, page: { limit: 1, after: null } });
    assertEquals(page1.items.length, 1);
    assertEquals(page1.has_more, true);
    assert(page1.next_cursor !== null);
    assertEquals(page1.items[0]?.telegram_message_id, 51);
    assertEquals(page1.items[0]?.has_replies, true);
    assertEquals(page1.items[0]?.author_id, "1051");
    assertEquals(page1.items[0]?.reply_to, null);
    const after = (JSON.parse(atob(page1.next_cursor)) as { after: string }).after;
    const page2 = await listComments(deps, { postId, page: { limit: 1, after } });
    assertEquals(page2.items[0]?.telegram_message_id, 53);
    assertEquals(page2.next_cursor, null);
    await deletePost(deps, postId);
    const afterDelete = await listComments(deps, { postId, page: page10 });
    assertEquals(afterDelete.items.length, 2, "a deleted post still lists");
    await expectHttp(listComments(deps, { postId: UNKNOWN, page: page10 }), 404, "post_not_found");
  });
});

Deno.test("listCommentReplies returns direct children; unknown ids are 404", async () => {
  await withDb(async (db) => {
    const { deps, postId } = await world(db);
    const [parent] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined);
    const replies = await listCommentReplies(deps, { postId, commentId: parent.id, page: page10 });
    assertEquals(replies.items.map((r) => r.telegram_message_id), [52]);
    assertEquals(replies.items[0]?.reply_to, parent.id);
    await expectHttp(
      listCommentReplies(deps, { postId, commentId: UNKNOWN, page: page10 }),
      404,
      "comment_not_found",
    );
    await expectHttp(
      listCommentReplies(deps, { postId: UNKNOWN, commentId: parent.id, page: page10 }),
      404,
      "post_not_found",
    );
  });
});

Deno.test("reply: sends, stores the account's row, lists as a reply", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    const [parent] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined);
    const view = await replyToComment(deps, { postId, commentId: parent.id, text: "thanks" });
    assertEquals(view.reply_to, parent.id);
    assertEquals(view.text, "thanks");
    assertEquals([view.author_username, view.author_id, view.author_name], ["alice", "1", "Alice"]);
    assertEquals(view.has_replies, false);
    assertEquals(view.posted_at, "2026-01-01T10:15:30.000Z");
    const sent = fake.calls.filter((c) => c.startsWith("sendReply"));
    assertEquals(sent, [`sendReply(${String(CHAT)}, 51, "thanks", null)`]);
    const replies = await listCommentReplies(deps, { postId, commentId: parent.id, page: page10 });
    assertEquals(replies.items.map((r) => r.telegram_message_id), [52, view.telegram_message_id]);
    // the next sync sees the reply on Telegram and skips it
    const client = await fake.forUser("alice");
    const page = await client.getThreadMessages(CHAT, ROOT, 53, 100);
    await insertFromMessages(db, postId, page.messages);
    const again = await listCommentReplies(deps, { postId, commentId: parent.id, page: page10 });
    assertEquals(again.items.length, 2);
  });
});

Deno.test("reply refusals: validation, deleted comment, deleted post, unknown ids", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    const [parent, other] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined && other !== undefined);
    await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "" }),
      400,
      "malformed_message",
    );
    assertEquals(fake.calls.filter((c) => c.startsWith("getMessages")).length, 0, "Telegram untouched");
    // target deleted on Telegram since it was stored
    fake.deleteMessage(CHAT, 53);
    const gone = await expectHttp(
      replyToComment(deps, { postId, commentId: other.id, text: "x" }),
      404,
      "comment_not_found",
    );
    assertEquals(gone.message, `comment ${other.id} was deleted`);
    const listed = await listComments(deps, { postId, page: page10 });
    assert(listed.items.find((c) => c.id === other.id)?.deleted_at !== null, "row marked deleted");
    await expectHttp(
      replyToComment(deps, { postId, commentId: other.id, text: "x" }),
      404,
      "comment_not_found",
    );
    assertEquals(fake.calls.filter((c) => c.startsWith("sendReply")).length, 0);
    await expectHttp(
      replyToComment(deps, { postId, commentId: UNKNOWN, text: "x" }),
      404,
      "comment_not_found",
    );
    await expectHttp(
      replyToComment(deps, { postId: UNKNOWN, commentId: parent.id, text: "x" }),
      404,
      "post_not_found",
    );
    await deletePost(deps, postId);
    const del = await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      404,
      "post_not_found",
    );
    assertEquals(del.message, `post ${postId} was deleted`);
  });
});

Deno.test("reply to an edited comment: 409 with the refreshed item, then the retry goes through", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    const [parent] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined);
    fake.editMessage(CHAT, 51, "m51 edited", new Date("2026-01-02T08:00:00Z"));
    const err = await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      409,
      "comment_edited",
    );
    assertEquals(err.message, `comment ${parent.id} was edited since it was stored`);
    const comment = err.extra.comment as { text: string; edited_at: string; has_replies: boolean };
    assertEquals(
      [comment.text, comment.edited_at, comment.has_replies],
      ["m51 edited", "2026-01-02T08:00:00.000Z", true],
    );
    assertEquals(fake.calls.filter((c) => c.startsWith("sendReply")).length, 0, "nothing posted");
    const ok = await replyToComment(deps, { postId, commentId: parent.id, text: "x" });
    assertEquals(ok.reply_to, parent.id);
  });
});

Deno.test("reply: library errors from for_user, resolve_user and send_reply", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    const [parent] = (await listComments(deps, { postId, page: page10 })).items;
    assert(parent !== undefined);
    fake.failOn("resolveUser", new PeerNotFound("alice"));
    await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      502,
      "upstream_failure",
    );
    fake.failOn("sendReply", new Forbidden("CHAT_WRITE_FORBIDDEN"));
    const forbidden = await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      502,
      "upstream_failure",
    );
    assertEquals(forbidden.extra.upstream_error, "CHAT_WRITE_FORBIDDEN");
    fake.accounts.delete("alice");
    await expectHttp(
      replyToComment(deps, { postId, commentId: parent.id, text: "x" }),
      404,
      "user_not_found",
    );
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `deno test -A src/telegram/tests/comments_handlers_test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `src/telegram/api/handlers/comments.ts`**

```ts
import { z } from "zod";
import { HttpError } from "../../../api/errors.ts";
import { type PageQuery, type PageResult, toPage } from "../../../api/pagination.ts";
import type { Deps } from "../../../deps.ts";
import { isTelegramError } from "../../client/errors.ts";
import type { Sent } from "../../client/types.ts";
import {
  type CommentItem,
  type CommentRow,
  getComment,
  insertReply,
  listReplies,
  listTopLevel,
  markDeleted,
  refreshFromMessage,
  withHasReplies,
} from "../../models/comments.ts";
import { getPost, type PostRow, threadCoordinates } from "../../models/posts.ts";
import { translateReplyError } from "../errors.ts";

export const replyBodySchema = z.object({ text: z.string() });

const MAX_TEXT = 4096;
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]);

export function validateReplyText(text: string): void {
  if (text.trim() === "") {
    throw new HttpError(400, "malformed_message", "reply text can not be empty");
  }
  const codepoints = [...text];
  if (codepoints.length > MAX_TEXT) {
    throw new HttpError(400, "malformed_message", "reply text is too long");
  }
  codepoints.forEach((ch, position) => {
    const cp = ch.codePointAt(0) ?? 0;
    const control = (cp < 0x20 && !ALLOWED_CONTROL.has(cp)) || cp === 0x7f;
    const loneSurrogate = cp >= 0xd800 && cp <= 0xdfff;
    if (control || loneSurrogate) {
      const codepoint = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      throw new HttpError(
        400,
        "malformed_message_character",
        `reply text contains invalid character at ${String(position)}`,
        { position, codepoint },
      );
    }
  });
}

export interface CommentView {
  id: string;
  telegram_message_id: number;
  reply_to: string | null;
  text: string;
  author_name: string | null;
  author_username: string | null;
  author_id: string | null;
  has_replies: boolean;
  posted_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export function serializeComment(c: CommentItem): CommentView {
  return {
    id: c.id,
    telegram_message_id: c.telegramMessageId,
    reply_to: c.replyTo,
    text: c.text,
    author_name: c.authorName,
    author_username: c.authorUsername,
    author_id: c.authorId === null ? null : String(c.authorId),
    has_replies: c.hasReplies,
    posted_at: c.postedAt.toISOString(),
    edited_at: c.editedAt?.toISOString() ?? null,
    deleted_at: c.deletedAt?.toISOString() ?? null,
  };
}

async function requirePost(deps: Deps, postId: string): Promise<PostRow> {
  const post = await getPost(deps.db, postId);
  if (post === null) throw new HttpError(404, "post_not_found", `post ${postId} not found`);
  return post;
}

async function requireComment(deps: Deps, postId: string, commentId: string): Promise<CommentRow> {
  const comment = await getComment(deps.db, { id: commentId, postId });
  if (comment === null) {
    throw new HttpError(404, "comment_not_found", `comment ${commentId} not found`);
  }
  return comment;
}

export async function listComments(
  deps: Deps,
  input: { postId: string; page: PageQuery },
): Promise<PageResult<CommentView>> {
  await requirePost(deps, input.postId);
  const rows = await listTopLevel(deps.db, input.postId, input.page);
  const page = toPage(rows, input.page.limit);
  return { ...page, items: page.items.map(serializeComment) };
}

export async function listCommentReplies(
  deps: Deps,
  input: { postId: string; commentId: string; page: PageQuery },
): Promise<PageResult<CommentView>> {
  await requirePost(deps, input.postId);
  await requireComment(deps, input.postId, input.commentId);
  const rows = await listReplies(deps.db, input.commentId, input.page);
  const page = toPage(rows, input.page.limit);
  return { ...page, items: page.items.map(serializeComment) };
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function deletedComment(commentId: string): HttpError {
  return new HttpError(404, "comment_not_found", `comment ${commentId} was deleted`);
}

export async function replyToComment(
  deps: Deps,
  input: { postId: string; commentId: string; text: string },
): Promise<CommentView> {
  // 1. validate before touching Telegram
  validateReplyText(input.text);

  // 2. load the post, then the comment
  const post = await requirePost(deps, input.postId);
  if (post.deletedAt !== null) {
    throw new HttpError(404, "post_not_found", `post ${input.postId} was deleted`);
  }
  const comment = await requireComment(deps, input.postId, input.commentId);
  if (comment.deletedAt !== null) throw deletedComment(input.commentId);
  const coords = threadCoordinates(post);
  const ctx = { username: post.username, commentId: input.commentId };

  try {
    const client = await deps.telegram(post.username);

    // 3. re-read the target and refresh the row before answering
    const [current] = await client.getMessages(coords.chatId, [comment.telegramMessageId]);
    if (current === undefined || current.kind === "deleted") {
      await markDeleted(deps.db, comment.id, deps.now());
      throw deletedComment(input.commentId);
    }
    if (!sameInstant(current.editedAt, comment.editedAt)) {
      const refreshed = await refreshFromMessage(deps.db, comment.id, {
        text: current.text,
        editedAt: current.editedAt,
      });
      throw new HttpError(
        409,
        "comment_edited",
        `comment ${input.commentId} was edited since it was stored`,
        { comment: serializeComment(await withHasReplies(deps.db, refreshed)) },
      );
    }

    // 4. send: resolve the account first, so a failure there posts nothing
    const self = await client.resolveUser(post.username);
    let sent: Sent;
    try {
      sent = await client.sendReply(
        coords.chatId,
        comment.telegramMessageId,
        input.text,
        coords.topicId,
      );
    } catch (e: unknown) {
      if (isTelegramError(e) && e.kind === "message_not_found") {
        await markDeleted(deps.db, comment.id, deps.now());
      }
      throw e;
    }

    // 5. store the reply as an ordinary comment row
    const row = await insertReply(deps.db, {
      postId: post.id,
      telegramMessageId: sent.messageId,
      replyToMessageId: comment.telegramMessageId,
      replyTo: comment.id,
      authorId: self.id,
      authorUsername: post.username,
      authorName: self.name,
      text: input.text,
      postedAt: sent.postedAt,
      editedAt: null,
    });
    return serializeComment(await withHasReplies(deps.db, row));
  } catch (e: unknown) {
    if (e instanceof HttpError) throw e;
    return translateReplyError(e, ctx);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `deno test -A src/telegram/tests/comments_handlers_test.ts`
Expected: PASS (seven tests).

- [ ] **Step 6: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/telegram/api/handlers/comments.ts src/telegram/tests/comments_handlers_test.ts src/telegram/client/fake.ts
git commit -m "Add comment handlers: paged listings and reply with target re-read"
```

---

### Task 11: Telegram sync runner

**Files:**
- Create: `src/telegram/sync.ts`, `src/telegram/tests/sync_test.ts`

**Interfaces:**
- Consumes: `PlatformSyncRunner`, `Lease`, `RunOutcome` (Task 6); `getPost`, `threadCoordinates`, `markSyncSuccess`, `markSyncFailure` (Task 7); `insertFromMessages` (Task 8); `translateSyncError` (Task 9); `runJob`, `pickJobs`, `ensureActiveJob`, `listRunsForPost` (tests).
- Produces: `createTelegramSyncRunner(deps: Deps, options: { pageSize: number }): PlatformSyncRunner`.

- [ ] **Step 1: Write the failing tests `src/telegram/tests/sync_test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import type { Deps } from "../../deps.ts";
import { getJobByPost, pickJobs } from "../../sync/models/jobs.ts";
import { listRunsForPost } from "../../sync/models/runs.ts";
import { runJob } from "../../sync/run.ts";
import { submitPost } from "../api/handlers/posts.ts";
import { listComments } from "../api/handlers/comments.ts";
import { FloodWait, SessionInvalid } from "../client/errors.ts";
import { FakeTelegram } from "../client/fake.ts";
import { getPost } from "../models/posts.ts";
import { createTelegramSyncRunner } from "../sync.ts";

const CHAT = 200;
const ROOT = 50;
const page = { limit: 100, after: null };

async function world(db: Db): Promise<{ deps: Deps; fake: FakeTelegram; postId: string }> {
  const fake = new FakeTelegram();
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.linkDiscussion(100, 5, { chatId: CHAT, rootMessageId: ROOT });
  const deps: Deps = { db, telegram: (u) => fake.forUser(u), now: () => new Date() };
  const { id } = await submitPost(deps, {
    title: "p",
    username: "alice",
    url: "https://t.me/mychannel/5",
  });
  return { deps, fake, postId: id };
}

async function runOnce(deps: Deps, pageSize = 100): Promise<void> {
  const [job] = await pickJobs(deps.db, { batchSize: 1, leaseMs: 60_000 });
  assert(job !== undefined, "a job was due");
  await runJob(deps, createTelegramSyncRunner(deps, { pageSize }), job, 60_000);
}

Deno.test("a run ingests one page, moves the mark, records success", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    for (let id = 51; id <= 53; id++) fake.addMessage(CHAT, ROOT, { id, replyToMessageId: ROOT, text: `m${String(id)}` });
    fake.addMessage(CHAT, ROOT, { id: 54, replyToMessageId: 51, text: "reply" });
    await runOnce(deps, 2);
    let post = await getPost(db, postId);
    assertEquals(post?.lastSyncedMessageId, 52);
    assert(post?.lastSyncedAt !== null);
    assertEquals(post?.syncError, null);
    assertEquals((await listComments(deps, { postId, page })).items.length, 2);
    await runOnce(deps, 2);
    post = await getPost(db, postId);
    assertEquals(post?.lastSyncedMessageId, 54);
    const top = (await listComments(deps, { postId, page })).items;
    assertEquals(top.map((c) => c.telegram_message_id), [51, 52, 53]);
    assertEquals(top[0]?.has_replies, true);
    await runOnce(deps, 2);
    assertEquals((await getPost(db, postId))?.lastSyncedMessageId, 54, "empty page keeps the mark");
    const runs = await listRunsForPost(db, postId);
    assertEquals(runs.map((r) => r.status), ["success", "success", "success"]);
    assertEquals(fake.calls.filter((c) => c.startsWith("getThreadMessages")).length, 3);
    assert(fake.calls.some((c) => c.startsWith(`getThreadMessages(${String(CHAT)}, ${String(ROOT)}, 0, 2)`)));
  });
});

Deno.test("an ordinary failure is written to sync_error and the job stays active", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    fake.failNext(new FloodWait(30));
    await runOnce(deps);
    const post = await getPost(db, postId);
    assertEquals(post?.syncError, "flood_wait: FLOOD_WAIT_30");
    assertEquals(post?.lastSyncedAt, null);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, true);
    const [run] = await listRunsForPost(db, postId);
    assertEquals([run?.status, run?.error], ["failure", "flood_wait: FLOOD_WAIT_30"]);
    // the next run succeeds and clears the error
    await runOnce(deps);
    assertEquals((await getPost(db, postId))?.syncError, null);
  });
});

Deno.test("SessionInvalid and UserNotFound disable the job", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    fake.failNext(new SessionInvalid("AUTH_KEY_UNREGISTERED"));
    await runOnce(deps);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, false);
    assertEquals((await getPost(db, postId))?.syncError, "session_invalid: AUTH_KEY_UNREGISTERED");
    const second = await submitPost(deps, { title: "p", username: "alice", url: "https://t.me/mychannel/5" });
    assertEquals(second.status, 200);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, true, "resubmit re-enables");
    fake.accounts.delete("alice");
    await runOnce(deps);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, false);
    assertEquals((await getPost(db, postId))?.syncError, "user_not_found: user alice not found");
  });
});

Deno.test("a missing thread root fails the run without disabling", async () => {
  await withDb(async (db) => {
    const { deps, fake, postId } = await world(db);
    fake.threads.clear();
    await runOnce(deps);
    assertEquals((await getPost(db, postId))?.syncError?.startsWith("message_not_found"), true);
    assertEquals((await getJobByPost(db, { postId, platform: "telegram" }))?.isActive, true);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `deno test -A src/telegram/tests/sync_test.ts`
Expected: FAIL, `../sync.ts` not found.

- [ ] **Step 3: Write `src/telegram/sync.ts`**

```ts
import type { Deps } from "../deps.ts";
import type { PickedJob } from "../sync/models/jobs.ts";
import type { Lease, PlatformSyncRunner, RunOutcome } from "../sync/runner.ts";
import { translateSyncError } from "./api/errors.ts";
import type { Page } from "./client/types.ts";
import { insertFromMessages } from "./models/comments.ts";
import { getPost, markSyncFailure, markSyncSuccess, threadCoordinates } from "./models/posts.ts";

/**
 * One run: fetch one page above the post's high-water mark and write it in the lease's fenced
 * transaction. Resolves nothing; thread coordinates come from the post row.
 */
export function createTelegramSyncRunner(
  deps: Deps,
  options: { pageSize: number },
): PlatformSyncRunner {
  return {
    platform: "telegram",
    async run(job: PickedJob, lease: Lease): Promise<RunOutcome> {
      const post = await getPost(deps.db, job.postId);
      if (post === null) {
        return lease.commit(() =>
          Promise.resolve({ status: "failure", error: "post not found", disable: true })
        );
      }

      let page: Page;
      try {
        const coords = threadCoordinates(post);
        const client = await deps.telegram(post.username);
        page = await client.getThreadMessages(
          coords.chatId,
          coords.rootMessageId,
          post.lastSyncedMessageId ?? 0,
          options.pageSize,
        );
      } catch (e: unknown) {
        const { error, disable } = translateSyncError(e);
        return lease.commit(async (tx) => {
          await markSyncFailure(tx, post.id, error, deps.now());
          return { status: "failure", error, disable };
        });
      }

      return lease.commit(async (tx) => {
        await insertFromMessages(tx, post.id, page.messages);
        const maxId = page.messages.reduce<number | null>(
          (acc, m) => (acc === null || m.id > acc ? m.id : acc),
          null,
        );
        await markSyncSuccess(tx, post.id, { lastSyncedMessageId: maxId, at: deps.now() });
        return { status: "success" };
      });
    },
  };
}
```

`translateSyncError` rethrows anything that is not a library error (a bug, a database failure); `runJob` then closes the run as failure with the message and releases the lease, which is the intended behaviour for unexpected errors.

- [ ] **Step 4: Run the tests**

Run: `deno test -A src/telegram/tests/sync_test.ts`
Expected: PASS (four tests).

- [ ] **Step 5: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/telegram/sync.ts src/telegram/tests/sync_test.ts
git commit -m "Add Telegram sync runner: one page per fenced run"
```

---

### Task 12: Telegram HTTP routes

**Files:**
- Create: `src/telegram/api/api.ts`, `src/telegram/tests/api_test.ts`

**Interfaces:**
- Consumes: handlers from Tasks 9 and 10; `createApp`, `signToken`, `pageQuerySchema`, `toPageQuery`, `HttpError` (Task 4).
- Produces: `createTelegramApi(deps: Deps): Hono` mounted by `cli.ts` at `/telegram/v1`.

Route table (all under the mount path):

| Method | Path | Handler | Success |
|---|---|---|---|
| POST | `/posts` | `submitPost` | 201 or 200, body `{status, id, created_at}` |
| GET | `/posts/:postId` | `getPostView` | 200 |
| DELETE | `/posts/:postId` | `deletePost` | 200 |
| GET | `/posts/:postId/comments` | `listComments` | 200 `{status, items, next_cursor, has_more}` |
| POST | `/posts/:postId/comments/:commentId/reply` | `replyToComment` | 201 `{status, ...comment}` |
| GET | `/posts/:postId/comments/:commentId/replies` | `listCommentReplies` | 200 |

Request-shape errors (not in the spec, chosen here): a body that is not valid JSON or fails its schema is `400 malformed_body` with the first zod issue in `message`; an invalid query is `400 malformed_query`; a path id that is not a UUID is treated as unknown, i.e. `404 post_not_found` / `404 comment_not_found`, because PostgreSQL would otherwise reject the cast.

- [ ] **Step 1: Write the failing tests `src/telegram/tests/api_test.ts`**

```ts
import { assert, assertEquals } from "@std/assert";
import type { Hono } from "@hono/hono";
import { createApp } from "../../api/app.ts";
import { signToken } from "../../api/auth.ts";
import type { Db } from "../../db/client.ts";
import { withDb } from "../../db/tests/helpers.ts";
import type { Deps } from "../../deps.ts";
import { createTelegramApi } from "../api/api.ts";
import { FakeTelegram } from "../client/fake.ts";
import { insertFromMessages } from "../models/comments.ts";

const SECRET = "s";
const CHAT = 200;
const ROOT = 50;

interface Json {
  status: number;
  [key: string]: unknown;
}

async function world(db: Db): Promise<{ app: Hono; fake: FakeTelegram; headers: Record<string, string> }> {
  const fake = new FakeTelegram();
  fake.addAccount("alice", { id: 1, name: "Alice" });
  fake.addPeer("mychannel", { chatId: 100, kind: "channel" });
  fake.linkDiscussion(100, 5, { chatId: CHAT, rootMessageId: ROOT });
  fake.addMessage(CHAT, ROOT, { id: 51, replyToMessageId: ROOT, text: "hi" });
  const deps: Deps = { db, telegram: (u) => fake.forUser(u), now: () => new Date() };
  const app = createApp({
    jwtSecret: SECRET,
    mounts: [{ path: "/telegram/v1", app: createTelegramApi(deps) }],
  });
  const token = await signToken(SECRET, "test");
  return {
    app,
    fake,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  };
}

async function call(app: Hono, headers: Record<string, string>, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Json;
  return { status: res.status, json };
}

Deno.test("post lifecycle over HTTP", async () => {
  await withDb(async (db) => {
    const { app, headers } = await world(db);
    const created = await call(app, headers, "POST", "/telegram/v1/posts", {
      title: "My post",
      username: "alice",
      url: "https://t.me/mychannel/5",
    });
    assertEquals(created.status, 201);
    assertEquals(created.json.status, 201);
    const id = created.json.id as string;
    const again = await call(app, headers, "POST", "/telegram/v1/posts", {
      title: "My post",
      username: "alice",
      url: "https://t.me/mychannel/5",
    });
    assertEquals([again.status, again.json.status, again.json.id], [200, 200, id]);
    const got = await call(app, headers, "GET", `/telegram/v1/posts/${id}`);
    assertEquals(got.status, 200);
    assertEquals(got.json.comment_sync_enabled, true);
    const del = await call(app, headers, "DELETE", `/telegram/v1/posts/${id}`);
    assertEquals(del.status, 200);
    assert(typeof del.json.deleted_at === "string");
    const missing = await call(app, headers, "GET", "/telegram/v1/posts/not-a-uuid");
    assertEquals([missing.status, missing.json.code], [404, "post_not_found"]);
  });
});

Deno.test("request-shape errors", async () => {
  await withDb(async (db) => {
    const { app, headers } = await world(db);
    const bad = await call(app, headers, "POST", "/telegram/v1/posts", { title: "x" });
    assertEquals([bad.status, bad.json.code], [400, "malformed_body"]);
    const res = await app.request("/telegram/v1/posts", { method: "POST", headers, body: "{" });
    assertEquals(res.status, 400);
    assertEquals(((await res.json()) as Json).code, "malformed_body");
    const url = await call(app, headers, "POST", "/telegram/v1/posts", {
      title: "x",
      username: "alice",
      url: "https://t.me/mychannel/5?comment=1",
    });
    assertEquals([url.status, url.json.code], [400, "malformed_url"]);
    const noauth = await app.request("/telegram/v1/posts", { method: "POST" });
    assertEquals(noauth.status, 401);
  });
});

Deno.test("comments: list, reply, replies, paging query", async () => {
  await withDb(async (db) => {
    const { app, headers, fake } = await world(db);
    const created = await call(app, headers, "POST", "/telegram/v1/posts", {
      title: "My post",
      username: "alice",
      url: "https://t.me/mychannel/5",
    });
    const postId = created.json.id as string;
    const client = await fake.forUser("alice");
    await insertFromMessages(db, postId, (await client.getThreadMessages(CHAT, ROOT, 0, 100)).messages);

    const list = await call(app, headers, "GET", `/telegram/v1/posts/${postId}/comments?limit=10`);
    assertEquals(list.status, 200);
    const items = list.json.items as { id: string; telegram_message_id: number }[];
    assertEquals(items.map((i) => i.telegram_message_id), [51]);
    assertEquals(list.json.next_cursor, null);
    const commentId = items[0]?.id ?? "";

    const badLimit = await call(app, headers, "GET", `/telegram/v1/posts/${postId}/comments?limit=0`);
    assertEquals([badLimit.status, badLimit.json.code], [400, "malformed_query"]);
    const badCursor = await call(app, headers, "GET", `/telegram/v1/posts/${postId}/comments?cursor=zzz`);
    assertEquals([badCursor.status, badCursor.json.code], [400, "malformed_cursor"]);

    const empty = await call(app, headers, "POST", `/telegram/v1/posts/${postId}/comments/${commentId}/reply`, { text: "" });
    assertEquals([empty.status, empty.json.code], [400, "malformed_message"]);
    const reply = await call(app, headers, "POST", `/telegram/v1/posts/${postId}/comments/${commentId}/reply`, { text: "thanks" });
    assertEquals([reply.status, reply.json.status], [201, 201]);
    assertEquals(reply.json.reply_to, commentId);
    assertEquals(reply.json.author_username, "alice");

    const replies = await call(app, headers, "GET", `/telegram/v1/posts/${postId}/comments/${commentId}/replies`);
    assertEquals(replies.status, 200);
    assertEquals((replies.json.items as unknown[]).length, 1);

    const unknown = await call(app, headers, "GET", `/telegram/v1/posts/${postId}/comments/nope/replies`);
    assertEquals([unknown.status, unknown.json.code], [404, "comment_not_found"]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `deno test -A src/telegram/tests/api_test.ts`
Expected: FAIL, `../api/api.ts` not found.

- [ ] **Step 3: Write `src/telegram/api/api.ts`**

```ts
import { type Context, Hono } from "@hono/hono";
import { z } from "zod";
import { HttpError } from "../../api/errors.ts";
import { pageQuerySchema, toPageQuery } from "../../api/pagination.ts";
import type { Deps } from "../../deps.ts";
import {
  listCommentReplies,
  listComments,
  replyBodySchema,
  replyToComment,
} from "./handlers/comments.ts";
import { deletePost, getPostView, submitBodySchema, submitPost } from "./handlers/posts.ts";

const uuid = z.uuid();

function pathId(c: Context, name: string, code: string, noun: string): string {
  const raw = c.req.param(name) ?? "";
  if (!uuid.safeParse(raw).success) {
    throw new HttpError(404, code, `${noun} ${raw} not found`);
  }
  return raw;
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "malformed_body", "request body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.map(String).join(".")}`;
    throw new HttpError(400, "malformed_body", `${issue?.message ?? "invalid body"}${where}`);
  }
  return parsed.data;
}

function parsePage(c: Context) {
  const parsed = pageQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, "malformed_query", issue?.message ?? "invalid query");
  }
  return toPageQuery(parsed.data);
}

export function createTelegramApi(deps: Deps): Hono {
  const app = new Hono();

  app.post("/posts", async (c) => {
    const body = await parseBody(c, submitBodySchema);
    const result = await submitPost(deps, body);
    return c.json(result, result.status);
  });

  app.get("/posts/:postId", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    return c.json(await getPostView(deps, postId), 200);
  });

  app.delete("/posts/:postId", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    return c.json(await deletePost(deps, postId), 200);
  });

  app.get("/posts/:postId/comments", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    const page = parsePage(c);
    const result = await listComments(deps, { postId, page });
    return c.json({ status: 200, ...result }, 200);
  });

  app.post("/posts/:postId/comments/:commentId/reply", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    const commentId = pathId(c, "commentId", "comment_not_found", "comment");
    const body = await parseBody(c, replyBodySchema);
    const view = await replyToComment(deps, { postId, commentId, text: body.text });
    return c.json({ status: 201, ...view }, 201);
  });

  app.get("/posts/:postId/comments/:commentId/replies", async (c) => {
    const postId = pathId(c, "postId", "post_not_found", "post");
    const commentId = pathId(c, "commentId", "comment_not_found", "comment");
    const page = parsePage(c);
    const result = await listCommentReplies(deps, { postId, commentId, page });
    return c.json({ status: 200, ...result }, 200);
  });

  return app;
}
```

If `c.json(result, result.status)` rejects the `200 | 201` union, write `return result.status === 201 ? c.json(result, 201) : c.json(result, 200);`. Give `parsePage` an explicit return type `PageQuery` (import it) to satisfy the explicit-return-type lint rule if it is enabled.

- [ ] **Step 4: Run the tests**

Run: `deno test -A src/telegram/tests/api_test.ts`
Expected: PASS (three tests).

- [ ] **Step 5: fmt, check, test, commit**

Run: `deno fmt && deno task check && deno task test`

```bash
git add src/telegram/api/api.ts src/telegram/tests/api_test.ts
git commit -m "Add /telegram/v1 routes"
```

---

### Task 13: CLI, Docker, compose, env, README, end-to-end smoke

**Files:**
- Create: `src/cli.ts`, `Dockerfile`, `.env.example`, `README.md`
- Modify: `compose.yaml` (add migrate, http, sync), `tsconfig.eslint.json` (paths for Cliffy transitive jsr specifiers only if the linter needs them)

**Interfaces:**
- Consumes: everything. `cli.ts` is the only file that imports both `api/`+`sync/` and `telegram/`.

- [ ] **Step 1: Write `src/cli.ts`**

```ts
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

function telegramFactory(config: Config): TelegramFactory {
  switch (config.telegramClient) {
    case "fake": {
      const fake = new FakeTelegram();
      seedDemo(fake);
      return (username) => fake.forUser(username);
    }
  }
}

function buildDeps(config: Config): { deps: Deps; handle: DbHandle } {
  const handle = createDb(config.databaseUrl);
  const deps: Deps = { db: handle.db, telegram: telegramFactory(config), now: () => new Date() };
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
    `sync: tick ${String(config.sync.tickMs)}ms, batch ${String(config.sync.batchSize)}, lease ${String(config.sync.leaseMs)}ms, concurrency ${String(config.sync.concurrency)}`,
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
```

If `deno task lint` reports `no-unsafe-*` on `withSync` or on `.action`, the Cliffy option types come through an unresolved `jsr:` import: add `paths` entries in `tsconfig.eslint.json` for the exact specifiers the vendored Cliffy files import (look in `vendor/jsr.io/@cliffy/command/1.2.1/*.ts`, e.g. `"jsr:@cliffy/flags@1.2.1": ["./vendor/jsr.io/@cliffy/flags/1.2.1/mod.ts"]`) until the types resolve. Do not disable the rule.

- [ ] **Step 2: Write `.env.example`**

```
# PostgreSQL 18 connection string. compose overrides it for services on the compose network.
DATABASE_URL=postgres://postgres:postgres@localhost:5432/comments
# Port the API listens on
PORT=8000
# HS256 secret that signs and verifies service JWTs
JWT_SECRET=dev-secret-change-me
# Scheduler: how often to pick due jobs
SYNC_TICK_MS=1000
# Scheduler: jobs picked per tick
SYNC_BATCH_SIZE=10
# Scheduler: lease length; a run heartbeats every half of it
SYNC_LEASE_MS=30000
# Scheduler: runs in flight at once
SYNC_CONCURRENCY=10
# Sync: messages fetched per run, at most 100
SYNC_PAGE_SIZE=100
# Telegram library binding. Only "fake" exists: an in-memory Telegram seeded with account "demo"
TELEGRAM_CLIENT=fake
```

- [ ] **Step 3: Write `Dockerfile`**

```dockerfile
FROM denoland/deno:2.9.6
WORKDIR /app
COPY deno.json deno.lock tsconfig.eslint.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
RUN deno install --allow-scripts
RUN deno cache src/cli.ts
CMD ["deno", "task", "serve"]
```

(If the `denoland/deno:2.9.6` tag does not exist, use `denoland/deno:latest` and record the resolved version in the README. If `deno install` refuses because of the minimum dependency age inside the image, add `--min-dep-age 0`.)

- [ ] **Step 4: Complete `compose.yaml`**

```yaml
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: comments
    ports:
      - "5432:5432"
    volumes:
      - dbdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d comments"]
      interval: 2s
      timeout: 3s
      retries: 30

  migrate:
    build: .
    command: deno task migrate
    env_file: .env
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/comments
    depends_on:
      db:
        condition: service_healthy
    restart: "no"

  http:
    build: .
    command: deno task dev:serve
    env_file: .env
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/comments
    ports:
      - "8000:8000"
    volumes:
      - ./src:/app/src
      - ./deno.json:/app/deno.json
      - ./deno.lock:/app/deno.lock
    depends_on:
      migrate:
        condition: service_completed_successfully

  sync:
    build: .
    command: deno task dev:sync
    env_file: .env
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/comments
    volumes:
      - ./src:/app/src
      - ./deno.json:/app/deno.json
      - ./deno.lock:/app/deno.lock
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  dbdata:
```

Keep the `db` volume path that Task 2 verified. Note: because `serve` and `sync` are separate containers, each has its own `FakeTelegram` world; a reply sent through `http` is not visible to the `sync` container's fake. That is the known cost of the local two-process split (constitution, "Two processes, locally") made sharper by the in-memory fake; say so in the README.

- [ ] **Step 5: Write `README.md`**

Follow the constitution's README section, in this order. Content to include:

1. **What it is.** One paragraph: stores Telegram posts submitted by a consumer, syncs their comment threads with a leased scheduler, lists comments and replies with cursor paging, and sends replies through a Telegram library the service does not own. Link `process/spec.md` for business rules and `process/constitution.md` for code conventions. State that the Telegram library is external; this repository holds its interface and an in-memory fake used for tests and the local environment.
2. **Prerequisites.** Docker with Compose; Deno 2 (`curl -fsSL https://deno.land/install.sh | sh`) for tests and the pre-commit hook.
3. **Getting started.**
   ```
   cp .env.example .env
   docker compose up
   ```
   API answers on `http://localhost:8000`. Prove it:
   ```
   curl -s localhost:8000/health
   ```
   Then a token and a submit against the fake's demo world (the fake seeds account `demo`, channel `demo_channel` with post `1` and two comments):
   ```
   TOKEN=$(deno eval 'import { signToken } from "./src/api/auth.ts"; console.log(await signToken(Deno.env.get("JWT_SECRET") ?? "dev-secret-change-me", "dev"))')
   curl -s -X POST localhost:8000/telegram/v1/posts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"title":"Demo","username":"demo","url":"https://t.me/demo_channel/1"}'
   curl -s "localhost:8000/telegram/v1/posts/<id>/comments" -H "Authorization: Bearer $TOKEN"
   ```
4. **Day-to-day.** Hot reload (`http`/`sync` run under `--watch` with `src/` mounted); new migration: edit a `models/schema.ts`, `deno task db:generate`, review the SQL, `docker compose run --rm migrate`; reset: `docker compose down -v`; tests: `docker compose up -d db` then `deno install && deno task test` (uses `TEST_DATABASE_URL`, default `postgres://postgres:postgres@localhost:5432/comments_test`, created on first run); `deno task check`; hook: `deno task hooks`.
5. **CLI.** `serve [--with-sync]`, `sync`, `migrate`, one line each, plus the deployment note: deploy as `serve --with-sync` because one Telegram account's calls must share a process.
6. **Environment variables.** Every variable in `.env.example`, one line each, plus `TEST_DATABASE_URL`.
7. **Deviations from the constitution** (short list): `tsconfig.eslint.json` instead of `tsconfig.json` (Deno 2.9 reads a root `tsconfig.json`); zod used directly instead of `@hono/zod-validator`; jsr packages vendored and path-mapped for the linter, so versions are pinned exactly in two places; `has_more` added to list responses; separate fake worlds per container locally.

- [ ] **Step 6: Run fmt, check, test**

Run: `deno fmt && deno task check && deno task test`
Expected: all pass (README.md is formatted by `deno fmt` too).

- [ ] **Step 7: End-to-end smoke through compose**

```bash
cp -n .env.example .env
docker compose up -d --build
docker compose ps            # db healthy, migrate exited 0, http and sync running
curl -s localhost:8000/health
TOKEN=$(deno eval 'import { signToken } from "./src/api/auth.ts"; console.log(await signToken("dev-secret-change-me", "dev"))')
curl -s -X POST localhost:8000/telegram/v1/posts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"title":"Demo","username":"demo","url":"https://t.me/demo_channel/1"}'
sleep 3
curl -s "localhost:8000/telegram/v1/posts/<id>" -H "Authorization: Bearer $TOKEN"        # comments_synced_at set
curl -s "localhost:8000/telegram/v1/posts/<id>/comments" -H "Authorization: Bearer $TOKEN" # two items
docker compose logs sync | tail
```

Expected: 201 on submit, then the sync container ingests the two seeded comments within a few seconds. Fix anything that fails before continuing; the compose stack is part of the deliverable.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts Dockerfile compose.yaml .env.example README.md tsconfig.eslint.json
git commit -m "Add CLI, Docker image, compose environment and README"
```

---

## Self-review notes (already applied)

- Spec coverage: submit (Task 9) covers url forms, peer resolution, discussion lookup for channels only, restore on conflict, job creation; get/delete (Task 9); list comments/replies with id paging and `has_replies` (Tasks 8, 10, 12); reply steps 1 to 5 including re-read, 409 refresh and marking deleted on `MessageNotFound` from the send (Task 10); sync pick/lease/fence/heartbeat/run rows (Tasks 5, 6) and the page write with `reply_to` backfill and high-water mark (Tasks 8, 11); error table per context (Task 9 `errors.ts`); the three CLI commands, compose, README (Task 13).
- Deliberately out of scope per spec: 401/403/429 semantics beyond a bare 401 for a missing token, backoff, run retention, edit/delete tracking outside the reply path.
- Naming used consistently across tasks: `ensureActiveJob`, `setJobActive`, `getJobByPost`, `pickJobs`, `heartbeatJob`, `fenceJob`, `releaseJob`, `openRun`, `closeRun`, `listRunsForPost`; `upsertPost`, `getPost`, `softDeletePost`, `markSyncSuccess`, `markSyncFailure`, `threadCoordinates`; `insertFromMessages`, `insertReply`, `getComment`, `listTopLevel`, `listReplies`, `markDeleted`, `refreshFromMessage`, `withHasReplies`; `submitPost`, `getPostView`, `deletePost`, `listComments`, `listCommentReplies`, `replyToComment`; `createTelegramSyncRunner`, `createTelegramApi`, `createApp`, `createScheduler`, `runJob`.
