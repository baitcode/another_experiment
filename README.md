# Foreword

Thank you very much for the opportunity, it was a fun ride!

This project is vibecoded heavily except for this section (well I've asked to read and fix language). Agent used Claude Max subscription Fable 5.1 model mostly using Max effort (Claude changes this setting for some reason to Extr High and I miss it always). I've used superpowers skill for brainstorming of initial project structure (`process/constitution.md`) and implementation of the project.

I've failed to document the whole process properly (I should've commited more often), so had to ask AI to check logs and summarise what It's been asked to do. You can find that log in (`process/ai_log.md`).

Whole thing started in the (`process/spec.md`) file, where I've outlined all of the initial assumptions about scoping and functional requirements of API and comment sync process, then I've defined the shape of API handlers. The important assumptions: I didn't want to pay too much attention to telegram client orchestraction and utilisation as it felt like a big task on it's own and focused on the API, data and scheduler implementation. I never checked if API's I've outlined for telegram client were ever possible to implement. Another assumption I've quickly decided on is not to try and build unified datamodel that would comfort all possible media platform as my experience tells that this task will most likely create a lot of problems for the future support, every new platform addition will affect all other platforms requiring for extensive testing, thoughful db schema migrations and lot's of genericly named entities without clear usage context. Scheduling, on the other side, seemed like something that might be unified, so I came up with a clear, rather simple solution for it. It has certain flaws, but without real data it's hard for me to optimise any further.

Then I've created data model stubs using yaml and with the help of AI I've generated and cleaned up SQL representation (should've used Typescript there, but, well, it is what it is). While discovering the implementation details in a dialogue with AI notes started to pile up. At some point I started to feel that the amount of details covers whole service functionality I've planned for. I've ran several sessions of AI-peered review. Reviewed datamodel, reviewed API and reviewed overall spec for contradictions and gaps several times until reviews stopped producing comments that made sense to me. After that I decided to stop and regenerated the whole spec in a concise way eliminating repetition as much as I could focusing on readability. By the time I've finished the spec, I was already 16 hours in this project and felt an urge to wrap up. So I've create a constitution document outlining the stack and QA properties and desired file structure, then launched superpowers agentic development skill to vibecode the whole thing. I've spent several hours reviewing `sync` module, simplified the API's and dropped lease extension feature. I didn't review the models and their operations, those might contain minor problems, but I decided to skip dealing with those for now, as I don't really have more time to spend on the task.

What I would do next:
- Build a telegram client orchestration feature a special process holding telegram session on user behalf providing with API methods.
- Test the whole thing manually

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
- **VS Code.** Install the Deno extension (`code --install-extension denoland.vscode-deno`) and
  enable it for the workspace (`Deno: Enable` from the command palette, or `"deno.enable": true`
  in `.vscode/settings.json`). Without it VS Code type-checks the project with its built-in
  Node-style TypeScript server, which cannot resolve `jsr:` imports or `.ts` import paths and
  reports errors that `deno check` does not.

## CLI

- `serve` - run the HTTP API; 
- `sync` - run the comment sync scheduler alone.
- `migrate` - apply pending database migrations.

Deploy as `serve --with-sync`: the Telegram library serialises calls per account on one
connection, so every caller of one account must share a process.

## Source layout

`src/` is split into platform-agnostic infrastructure and one folder per platform. Each folder
owns its own `tests/`; there are no cross-platform models.

- **`cli.ts`** - Cliffy entry point for the commands above, and the only place a platform is
  wired in: it builds the `Infra` object, mounts the platform's HTTP app and registers its sync
  runner.
- **`config.ts`** - reads and validates the environment variables below into a typed `Config`.
- **`deps.ts`** - the `Infra` interface (`db`, `telegram` client provider, `now`) that every
  handler, model and runner receives instead of importing globals.
- **`db/`** - the drizzle client and transaction helper, migrations, and `schema.ts`, which only
  re-exports every `models/schema.ts` so drizzle-kit sees one schema.
- **`api/`** - platform-agnostic HTTP: the Hono root with bearer-JWT auth and the error handler,
  plus the cursor and pagination helpers platform handlers share.
- **`sync/`** - the platform-agnostic scheduler: job and run tables, the tick loop with lease and
  concurrency limits, and `wrapRunner`, which commits a platform runner's write inside one fenced
  transaction.
- **`telegram/`** - the Telegram platform, and the template a new platform would copy:
  `models/` (posts, comments, their schema), `api/` (the mounted Hono app and its handlers),
  `client/` (the external library's interface, its errors and the in-memory fake) and `sync.ts`,
  the `PlatformSyncRunner` that fetches one page of comments per run.
- **`tests/`** - tests for the top-level files, currently `config.ts`.

The full file-by-file listing is under "Layout" in
[process/constitution.md](process/constitution.md).

## Environment variables

| Variable            | Purpose                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`      | PostgreSQL 18 connection string.                                                                                                                                                     |
| `PORT`              | Port the API listens on.                                                                                                                                                             |
| `JWT_SECRET`        | HS256 secret that signs and verifies service JWTs.                                                                                                                                   |
| `SYNC_TICK_MS`      | Scheduler: how often to pick due jobs.                                                                                                                                               |
| `SYNC_BATCH_SIZE`   | Scheduler: jobs picked per tick.                                                                                                                                                     |
| `SYNC_LEASE_MS`     | Scheduler: lease length; size it for the slowest normal upstream call, a run never extends it.                                                                                       |
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
