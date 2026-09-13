# Telegram comment service

Stores Telegram posts submitted by a consumer, syncs their comment threads with a leased
scheduler, and lists comments and replies with cursor paging; replies are sent back through a
Telegram library this service does not own. That library is external: this repository holds only
its interface (`src/telegram/client/client.ts`) and an in-memory fake (`src/telegram/client/fake.ts`)
used for tests and the local environment. Business rules are in [process/spec.md](process/spec.md);
code conventions are in [process/constitution.md](process/constitution.md).

## Prerequisites

- Docker with Compose, to run the service.
- Deno 2 (`curl -fsSL https://deno.land/install.sh | sh`), to run tests and the pre-commit hook.

## Getting started

```
cp .env.example .env
docker compose up
```

The API answers on `http://localhost:8000`. Prove it:

```
curl -s localhost:8000/health
```

Then a token and a submit against the fake's demo world (it seeds account `demo`, channel
`demo_channel` with post `1` and two comments):

```
TOKEN=$(deno eval 'import { signToken } from "./src/api/auth.ts"; console.log(await signToken(Deno.env.get("JWT_SECRET") ?? "dev-secret-change-me", "dev"))')
curl -s -X POST localhost:8000/telegram/v1/posts -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Demo","username":"demo","url":"https://t.me/demo_channel/1"}'
curl -s "localhost:8000/telegram/v1/posts/<id>/comments" -H "Authorization: Bearer $TOKEN"
```

## Day-to-day

- **Hot reload.** `http` and `sync` run under `deno run --watch` with `src/` mounted from the
  host, so saving a file restarts the process in the container; no rebuild, no `up`.
- **New migration.** Edit a `models/schema.ts`, run `deno task db:generate`, review the generated
  SQL, then apply it with `docker compose run --rm migrate`.
- **Reset the database.** `docker compose down -v`.
- **Tests.** `docker compose up -d db`, then `deno install && deno task test` (uses
  `TEST_DATABASE_URL`, default `postgres://postgres:postgres@localhost:5432/comments_test`,
  created on first run).
- **Type check, lint and format check.** `deno task check`.
- **Pre-commit hook.** `deno task hooks`.

## CLI

- `serve [--with-sync]` - run the HTTP API; `--with-sync` also runs the scheduler in this process.
- `sync` - run the comment sync scheduler alone.
- `migrate` - apply pending database migrations.

Deploy as `serve --with-sync`: the Telegram library serialises calls per account on one
connection, so every caller of one account must share a process.

## Environment variables

| Variable            | Purpose                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`      | PostgreSQL 18 connection string.                                                                                                                                                     |
| `PORT`              | Port the API listens on.                                                                                                                                                             |
| `JWT_SECRET`        | HS256 secret that signs and verifies service JWTs.                                                                                                                                   |
| `SYNC_TICK_MS`      | Scheduler: how often to pick due jobs.                                                                                                                                               |
| `SYNC_BATCH_SIZE`   | Scheduler: jobs picked per tick.                                                                                                                                                     |
| `SYNC_LEASE_MS`     | Scheduler: lease length; a run heartbeats every half of it.                                                                                                                          |
| `SYNC_CONCURRENCY`  | Scheduler: runs in flight at once.                                                                                                                                                   |
| `SYNC_PAGE_SIZE`    | Sync: messages fetched per run, at most 100.                                                                                                                                         |
| `TELEGRAM_CLIENT`   | Telegram library binding. Only `fake` exists: an in-memory Telegram seeded with account `demo`.                                                                                      |
| `TEST_DATABASE_URL` | PostgreSQL connection string the test suite runs against; default `postgres://postgres:postgres@localhost:5432/comments_test`, created on first run. Not read by the service itself. |

## Deviations from the constitution

- `tsconfig.eslint.json` is used instead of `tsconfig.json`, because Deno 2.9 reads a root
  `tsconfig.json` itself; ESLint's type-aware parser points at the `.eslint.json` copy instead.
- `zod` is used directly for request and config validation instead of `@hono/zod-validator`.
- jsr packages are vendored under `vendor/` and path-mapped in `tsconfig.eslint.json` for the
  linter, so their versions are pinned exactly in two places (`deno.json` and that file).
- `has_more` was added to list responses alongside `next_cursor`.
- Locally, `http` and `sync` run as separate compose containers, each with its own in-memory
  `FakeTelegram` world: a reply sent through `http` is not visible to the `sync` container's fake.
  That is the known cost of the local two-process split (constitution, "Two processes, locally")
  made sharper by the in-memory fake. It does not affect the deployment shape, which stays
  `serve --with-sync`.
- `telegram/models/comments.ts` imports the `Message` type from `telegram/client/types.ts`
  (type-only, same platform folder).

## Verification status

Unit and integration tests pass against PostgreSQL 18, and the compose stack has been exercised
end to end: `docker compose up` migrates, `http` answers on port 8000, a submitted demo post is
synced by the `sync` container within a few seconds, and listing, replying and resubmitting behave
as the spec describes.
