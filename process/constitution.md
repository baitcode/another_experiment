# Constitution

Code conventions for the service specified in spec.md. Business rules live there; this document says how the code is built.

# Stack

```yaml
runtime:
  choice: Deno 2
  why:    one runtime for API, scheduler and tooling; TypeScript without a build step

http:
  choice: Hono (jsr:@hono/hono) with zod validator
  why:    smallest typed router that runs on Deno.serve unchanged

database:
  choice: PostgreSQL 18+
  why:    uuidv7() defaults, per spec

driver:
  choice: postgres.js (npm:postgres)
  why:    fastest driver with a first-party Drizzle dialect

models_and_queries:
  choice: Drizzle ORM (npm:drizzle-orm)
  why:    tables declared in TypeScript; queries stay SQL-shaped

migrations:
  choice: drizzle-kit
  why:    generated from the TypeScript tables; SQL files reviewed and committed

cli:
  choice: Cliffy (jsr:@cliffy/command)
  why:    subcommands with typed options and help

tests:
  choice: deno test against a real PostgreSQL 18
  why:    the logic that matters is in SQL: leases, conflicts, partial-index paging

lint:
  choice: ESLint with typescript-eslint, type-checked strict configs
  why:    deno lint has no type information; the strict type-aware rules catch unhandled promises, unsafe any and non-exhaustive switches

formatter:
  choice: deno fmt
  why:    ships with the runtime, no dependency and no config file; one canonical output so diffs carry code changes only
```

Not used: an ORM query layer beyond Drizzle's builder, a job-queue library, `Deno.cron`, a DI container.

# Processes

One codebase, one binary, three commands:

- `serve` runs the API. `--with-sync` also starts the scheduler in the same process.
- `sync` runs the scheduler alone.
- `migrate` applies pending migrations.

The Telegram library serialises calls per account on one connection, so all callers of one account must share a process. Until the library is its own service, deploy as `serve --with-sync`. The local compose runs `serve` and `sync` apart, see Local environment.

# Layout

```
README.md                 entry point for a new reader, see README
deno.json                 tasks: serve, sync, migrate, db:generate, test, check, dev:*
drizzle.config.ts         schema: src/db/schema.ts, out: drizzle/
drizzle/                  generated migrations, committed
Dockerfile                one image for migrate, http and sync; the command differs
compose.yaml              local environment: db, migrate, http, sync, see Local environment
.env.example              every variable config.ts reads, with local defaults; committed. .env is not
src/
  cli.ts                  Cliffy root; the only place platforms are wired in
  config.ts               env -> typed config
  deps.ts                 Deps = { db, telegram: (username) => TelegramClient, now }

  db/
    client.ts             driver + drizzle instance, transaction helper
    schema.ts             re-exports every models/schema.ts; drizzle-kit reads only this
    migrate.ts
    tests/helpers.ts      connect, migrate, reset between tests

  api/                    platform-agnostic HTTP
    app.ts                Hono root: auth, error handler, mounts platform apps
    auth.ts               bearer JWT
    errors.ts             HttpError { status, code, message, extra } -> Response
    cursor.ts             base64 {"after": id}
    pagination.ts         limit/cursor schema; { items, next_cursor, has_more }
    tests/

  sync/                   platform-agnostic scheduler
    models/
      schema.ts           post_comments_sync_jobs, post_comments_sync_runs
      jobs.ts             pick, fenced re-take, heartbeat, release, disable
      runs.ts             open, close
    runner.ts             interface PlatformSyncRunner { platform; run(job, token) }
    run.ts                open run -> runner.run -> close run, release lease
    scheduler.ts          tick loop, concurrency cap, runners keyed by platform
    tests/

  telegram/               one folder per platform; a new platform copies this shape
    models/
      schema.ts           telegram_posts, telegram_comments, partial indexes
      posts.ts            post queries; threadCoordinates(post)
      comments.ts         comment queries; reply_to backfill; refresh on reply
    client/
      types.ts            Peer, User, Thread, Message, Deleted, Sent
      errors.ts           library error classes with a `kind` discriminator
      client.ts           interface TelegramClient: the six methods
      fake.ts             in-memory implementation for tests
    sync.ts               PlatformSyncRunner for 'telegram'
    api/
      api.ts              Hono sub-app for /telegram/v1; routes only
      errors.ts           library error -> HttpError; one switch per context
      handlers/
        posts.ts          url parser, body schema, serializer, submit/get/delete
        comments.ts       body schema, serializer, list/reply/listReplies
    tests/
```

# Rules

**Dependencies point one way.** `api/` and `sync/` never import `telegram/`. `telegram/models/` imports only `db/`. `telegram/sync.ts` imports models and client only. `telegram/client/` imports nothing from the service. `cli.ts` is the sole exception: it wires platform apps and runners in.

**Models own their queries.** Every SQL statement for a table lives in that table's file under `models/`. Handlers and runners compose model calls; they never build queries.

**Handlers are functions, not middleware.** A handler takes `Deps` and parsed input and returns a result or throws. `api.ts` parses the request, calls the handler, serialises the result. Handlers are tested without HTTP.

**Errors are translated at the edge, once.** Library errors carry a `kind`. Each context that can meet one, submit, reply and sync, maps it in one exhaustive switch. No library error reaches `api/errors.ts` untranslated, and no code string-matches an error message.

**The scheduler owns the lease; the platform owns the page.** `sync/` implements pick, heartbeat, fence and run rows and dispatches by the job's `platform` column. A platform runner fetches one page and writes it in one fenced transaction, nothing more.

**Dependencies are explicit.** `Deps` is built in `cli.ts` and passed down. Tests pass the fake client and a real database.

**Schema is code.** Tables are declared in `models/schema.ts` files. `deno task db:generate` produces a migration; the generated SQL is reviewed, edited if needed, and committed. The database is never altered by hand.

**Tests run against PostgreSQL 18.** Each module keeps its tests in `tests/`, named `*_test.ts`. Model, lease and paging tests hit the database; handler tests use the fake client and the database; API tests go through Hono's `request()`.

**Every change is formatted, linted and tested before it is considered done.** After any edit to the code, however small, run `deno fmt`, then `deno task check`, then `deno task test`, in that order, and fix what they report before moving on. This applies to a human and to an AI agent alike, to a one-line fix as much as a feature, and to changes that "cannot affect tests". A change is not finished, not reviewable and not committable until all three pass; reporting it as done without having run them is a defect in its own right. The pre-commit hook and CI catch what was skipped, they do not replace running it.

# Linting

ESLint runs through Deno's npm compatibility with typescript-eslint in type-aware mode. Configuration is `eslint.config.ts` at the repo root.

```yaml
configs:
  - typescript-eslint/strictTypeChecked
  - typescript-eslint/stylisticTypeChecked

parser:
  projectService: true          # type information from tsconfig.json
  tsconfigRootDir: .

tsconfig.json:                  # read by ESLint only; Deno reads deno.json
  strict: true
  noUncheckedIndexedAccess: true
  exactOptionalPropertyTypes: true
  noFallthroughCasesInSwitch: true
  types: [npm:@types/deno]      # Deno global for the linter

rules_never_disabled:
  - @typescript-eslint/no-floating-promises
  - @typescript-eslint/no-misused-promises
  - @typescript-eslint/switch-exhaustiveness-check
  - @typescript-eslint/no-explicit-any
  - @typescript-eslint/no-unsafe-*
  - @typescript-eslint/no-non-null-assertion
  - @typescript-eslint/strict-boolean-expressions
```

An inline `eslint-disable` needs a reason on the same line and a reviewer who agrees. Config-level disables are not allowed. `deno fmt` owns formatting; ESLint carries no formatting rules.

# Formatting

`deno fmt` is the only formatter. Its settings live in `deno.json` and are not overridden per file or per editor.

```yaml
fmt:
  lineWidth:    100
  indentWidth:  2
  useTabs:      false
  singleQuote:  false
  semiColons:   true
  proseWrap:    preserve
  include:      [src/, tests/, "*.ts", "*.md", "*.json"]
```

Code is committed formatted. `deno task check` runs `deno fmt --check` and fails on any difference, so the pre-commit hook and CI both refuse unformatted code. Editors run `deno fmt` on save. Generated files under `drizzle/` are excluded and never hand-formatted.

# Pre-commit hook

Every commit runs the linter. The hook is versioned in `.githooks/pre-commit` and activated once per clone:

```
deno task hooks              git config core.hooksPath .githooks
```

The hook runs `deno task check` on the staged tree and refuses the commit on any failure. `--no-verify` is not used; a commit that cannot pass the check is not ready. CI runs the same task, so the hook is a shortcut, not the gate.

# Tasks

```
deno task serve          deno run -A src/cli.ts serve
deno task sync           deno run -A src/cli.ts sync
deno task migrate        deno run -A src/cli.ts migrate
deno task dev:serve      deno run -A --watch src/cli.ts serve
deno task dev:sync       deno run -A --watch src/cli.ts sync
deno task db:generate    deno run -A npm:drizzle-kit generate
deno task test           deno test -A src/
deno task lint           deno run -A npm:eslint src/
deno task check          deno check src/ && deno task lint && deno fmt --check
deno task hooks          git config core.hooksPath .githooks
```

# Local environment

`docker compose up` at the repo root brings up the whole service. Nothing but Docker is installed on the host to run it; Deno on the host is for the editor, tests and the pre-commit hook.

```yaml
services:
  db:
    image:        postgres:18
    ports:        5432
    volumes:      named volume for data, so `down` keeps the database and `down -v` resets it
    healthcheck:  pg_isready

  migrate:                    # sidecar: applies pending migrations once and exits
    build:        Dockerfile
    command:      deno task migrate
    depends_on:   db is healthy
    restart:      "no"

  http:
    build:        Dockerfile
    command:      deno task dev:serve
    ports:        8000
    depends_on:   migrate completed successfully
    volumes:      src/, deno.json, deno.lock mounted from the host

  sync:
    build:        Dockerfile
    command:      deno task dev:sync
    depends_on:   migrate completed successfully
    volumes:      src/, deno.json, deno.lock mounted from the host
```

**Hot reload.** `http` and `sync` run under `deno run --watch` with the source mounted from the host, so saving a file restarts the process inside the container; no rebuild, no `up`. The image is rebuilt only when `Dockerfile` or the dependency set changes: `docker compose build`.

**Migrations.** The sidecar runs on every `up`, so a fresh clone and a clone with new migrations both come up migrated. A migration added while the stack is running is applied with `docker compose run --rm migrate`; the running services are not restarted for it. The database is never migrated from the host.

**Two processes, locally.** `http` and `sync` are separate containers so each can be restarted, stopped or attached to alone. That is the split Processes says not to deploy: two processes sharing one Telegram account collide on its connection. Locally the split is accepted; the deployment shape stays `serve --with-sync`.

**Config.** Services read the same environment variables as any other run of the binary, see `config.ts`; compose sets the ones that point inside the network, `DATABASE_URL` first, and takes the rest from `.env`. `.env.example` lists every variable with a working local value and is the file a new clone copies. Nothing in `compose.yaml` is specific to one developer's machine.

# README

`README.md` at the repo root is the first file a new reader opens and the only one that has to be read before running the service. It holds, in this order:

1. What the service does, in one paragraph, and links to spec.md and constitution.md for the rest.
2. Prerequisites: Docker with Compose, and Deno 2 for tests and the hook.
3. Getting started: copy `.env.example` to `.env`, `docker compose up`, the port the API answers on, and one `curl` that proves it is up.
4. Day-to-day: hot reload, applying a new migration, resetting the database, running `deno task test` and `deno task check`, activating the hook.
5. The three CLI commands and their options.
6. Every environment variable with one line on what it does.

The README does not repeat the spec or the constitution: business rules and code conventions are linked, not copied. A change to a task, a variable or a compose service updates the README in the same commit.
