# AGENTS.md

Guidance for anyone, human or AI, working in this repository.

## What this is

This repo builds a WhatsApp AI receptionist for Cumbident, a fictional dental studio, as n8n workflows backed by Postgres.
It is a portfolio demo: every file should read as production-quality, not a prototype.

## Map

- `compose.yaml`, `compose.queue.yaml`, `.env.example`: the local stack (Postgres, n8n, optional ngrok tunnel) and the optional queue-mode override.
- `ngrok/traffic-policy.yml`: the tunnel policy. It forwards one webhook path and rate-limits it.
- `db/schema.sql`, `db/init/`, `db/migrations/`: the baseline schema, the one-time role bootstrap, and every later change as a numbered migration.
- `config/config.example.json`: the config template. Your own `config/config.json` is gitignored.
- `business/`, `prompts/`: the business facts (every fixed reply as `{ en, es }`), the FAQ prose, and the system prompt template.
- `src/nodes/`: one `run()` function per Code node, compiled into workflow JSON. `src/nodes/shared/` holds the logic several nodes reuse.
- `workflows/`: the n8n workflow JSON that `pnpm run setup` imports. [docs/architecture.md](docs/architecture.md#what-each-component-does) describes each one.
- `scripts/`: the tooling CLIs. `scripts/manifest.ts` is the one source of fixed workflow and credential IDs and of the `CODE_NODES` table; `scripts/lib/` holds the shared helpers.
- `tests/`: Vitest suites, fixtures, helpers, and the scenario sets `scripts/run-scenarios.ts` grades.
- `docs/`: the documents under "Docs" below. `docs/diagrams/` holds the archify sources, pages and images.
- `.n8n-import/`: the live bind mount `pnpm run export` writes to. Never `rm -rf` it; [recovery](docs/architecture.md#security-and-data-handling) is in the architecture doc.

## Commands

- `pnpm install --frozen-lockfile`: install from the lockfile.
- `pnpm run typecheck`, `pnpm run lint`, `pnpm test`: `tsc --noEmit`, ESLint, Vitest. [docs/testing.md](docs/testing.md) lists every suite.
- `pnpm run build:workflows`: bundle each `src/nodes/*.ts` into its Code node. `-- --check` fails without writing when the committed JSON is stale. After an esbuild update, run it and commit the regenerated JSON.
- `pnpm run check`: the hygiene checker over `workflows/`. [docs/testing.md](docs/testing.md#build-and-hygiene-commands) lists what it rejects.
- `docker compose up -d --wait`: start Postgres and n8n. Add `--profile tunnel` for ngrok. `down -v` also wipes the volumes.
- `pnpm run db:migrate`: apply pending migrations as the superuser. [docs/database.md](docs/database.md#5-migrations) has the steps.
- `pnpm run setup`: migrate, import credentials, then publish the workflows into the local n8n.
- `pnpm run export`: write n8n's canonical form of every workflow back to `workflows/`. Run it after editing a workflow in the n8n UI, and commit the result.
- `pnpm run scenarios`: the triage table, then every conversation. `-- --triage`, `-- --only <id>` and `-- --tool-failure` narrow it. [docs/testing.md](docs/testing.md#scenario-suites) covers them.
- `node scripts/dev-call.ts <target> '<json>'`: call the dev harness without WhatsApp. [docs/testing.md](docs/testing.md#the-dev-harness) lists the targets.
- `node scripts/init-env.ts`: write `.env` from `.env.example` with random local secrets. It refuses to overwrite.
- `node scripts/check-dev-response.ts`, `node scripts/check-db.ts`: the stack checks CI's `n8n` job runs.
- Queue mode: the two commands are in the README's [When you'd need queue mode](README.md#when-youd-need-queue-mode), and [docs/architecture.md](docs/architecture.md#scaling-limits-and-what-to-change) covers the limits.
- Diagrams: regenerate one after editing its JSON source with archify v3.2.0; see [docs/architecture.md](docs/architecture.md#regenerating-the-diagrams).

## The gate

Run this before every commit that touches TypeScript, and before every commit that touches docs, since some tests read them:

`pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build:workflows -- --check && pnpm run check` all pass locally.

- No secrets anywhere in the diff or git history. `.env` and `config/config.json` are never committed.
- `README.md` (`Status`, `What it does`, and the quick start if commands changed) and this file are updated to match what the change actually adds.
- Commits follow Conventional Commits.
- The PR description states what was verified (commands and their output) and lists any deferred live checks, and the diff matches it.

## Rules an agent must not break

Most rules name what guards them; the rest are review rules.

- Secrets live only in `.env` and n8n credentials (gitleaks in CI). No script prints credential data.
- Test data uses the `5700000000` phone prefix and `example.com`. `cleanup` deletes by `starts_with` and refuses a short prefix (`tests/workflows/dev-harness.test.ts`).
- Postgres nodes connect as `app_runtime`. Only the chat-memory node connects as the owner (`tests/tooling.test.ts`, `scripts/check-db.ts`). A new table gets its grants in its own migration.
- Every workflow sets `saveManualExecutions: false` (`tests/workflows/execution-data.test.ts`).
- n8n stays on the 2.45 line, by digest, and prose names an exact patch only in a dated "checked against" note (`tests/runtime.test.ts`). Never move to an unstable `3.x` tag before one is stable, and when a bump touches the code a note describes, re-check that note's claim in the new image.
- Point tooling only at the local n8n, `http://localhost:5678`.
- Team emails are plain text with no sender name, and Sheets writes are raw (`tests/workflows/injection-guards.test.ts`).
- Agent tools take the phone from the trigger, never from the model, and map or remove every field the model shouldn't fill (`tests/workflows/process-message.test.ts`).
- `notify_team`'s `reason` stays clamped to `unknown_treatment`, `out_of_scope` or `other` (`tests/workflows/process-message.test.ts`).
- No Code node is hand-written. Each is a pure `run()` in `src/nodes/<name>.ts`, built by `pnpm run build:workflows` (`pnpm run check`).
- No `$n` in a SQL comment: n8n substitutes it (`pnpm run check`).
- Postgres nodes are typeVersion 2.8 or later where a parameter can carry free text. The reason is in the architecture doc's design decisions.
- Every external call retries 3 times, 1000 ms apart, except the two exceptions the architecture doc names (`pnpm run check`).
- An AI Agent never retries. Follow it with a reply-text check (`tests/workflows/process-message.test.ts`).
- `load-context` names no error workflow, so `error-handler` can't loop through it (`tests/workflows/load-context.test.ts`).
- No `.js` or `.mjs` sources. Scripts are `scripts/*.ts` run with native type stripping, and CLIs call programs with an argument array, never a shell string.
- A CLI guards its entry point with `if (process.argv[1] === fileURLToPath(import.meta.url))`, so tests can import its functions without side effects.
- A node whose failure the caller should see sets `onError: "continueErrorOutput"` and wires its error output to a response that reports the failure, instead of swallowing it.
- Every `config.limits.*` count is checked with `isPositiveInteger` (`src/nodes/shared/limits.ts`), and a missing or invalid one fails closed or switches its feature off, as the failure table says.
- Node names are actions, such as "Record inbound message", and a sticky note labels each canvas section (`tests/workflows/*.test.ts` check the sections).
- Everything is in English, except each `es` value in `business/business.json`, the `{ en, es }` tables in `src/nodes/`, the Spanish word list, and Spanish test inputs. [docs/languages.md](docs/languages.md) covers adding a language.
- No plan, task, ruling or review-finding reference in any file (`tests/hygiene.test.ts`). A comment states its own reason, a deliberate simplification gets one `NOTE:` line naming its ceiling, and a lint or ShellCheck disable comment names its reason.
- Importing and exporting twice in a row produces no diff. A new server-set field goes in `normalizeWorkflow`'s drop list (`tests/export-workflows.test.ts`).
- pnpm 11 with `minimumReleaseAge` as a feature, and images pinned by digest (`tests/supply-chain.test.ts`). Never touch `trustPolicy` or `minimumReleaseAge`. [docs/supply-chain.md](docs/supply-chain.md) has the rest.
- The TypeScript is strict (`pnpm run typecheck`): `tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax` and `erasableSyntaxOnly`, with no build step.

## Changing a workflow

1. Design the nodes and expressions against n8n's own node reference, especially for a node you haven't configured by hand.
2. Edit the JSON in `workflows/`, then run `pnpm run build:workflows` to regenerate any Code node it touches.
3. Validate the workflow JSON with an n8n-aware tool until it reports no errors.
4. Run `pnpm run setup` to import and publish it against the local n8n.
5. Run `pnpm run export`, and commit that exported output, not your hand-edited JSON.
6. Run the gate.

After any restart of the `n8n` container, wait 15 s before calling a workflow: `/healthz` turns healthy before the webhook routes register.

## Branches and releases

Work on a short-lived branch from `develop` and open a pull request into it. [CONTRIBUTING.md](CONTRIBUTING.md) has the branch flow, the squash rule and the release steps, including `release/vX.Y.Z` branches.

## Docs

Update the doc a change touches, in the same pull request:

| Document | Covers | Update it when a change |
|---|---|---|
| [`README.md`](README.md) | Status, quick start, Configuration, Test scenarios, the numbered live checks, cost, limitations. `tests/readme.test.ts` pins its section order. | Changes what the project does or how it starts |
| [`docs/architecture.md`](docs/architecture.md) | Components, the HTTP surface, the message lifecycle, the data model, failure modes, scaling, security, design decisions, diagram regeneration | Alters a component, the lifecycle, the data model, a failure mode, scaling, security or a decision |
| [`docs/database.md`](docs/database.md) | Roles and grants, every statement, migrations, retention, backup, `check-db` | Adds a query, a table, a grant or a migration |
| [`docs/red-team.md`](docs/red-team.md) | Where patient text reaches a model, every adversarial input and its guard | Adds a model input, a tool, a tool field the model fills, or a guard |
| [`docs/testing.md`](docs/testing.md) | Every suite, the stack checks, the harness targets, scenarios, what CI runs | Adds or removes a test file, a suite or a CI step |
| [`docs/supply-chain.md`](docs/supply-chain.md) | pnpm settings, updating a dependency, images, CI tools, Dependabot | Touches a dependency, an image or a CI tool |
| [`docs/languages.md`](docs/languages.md) | How replies and team emails pick a language, and how to add one | Touches language handling |
| `docs/diagrams/` | Five archify sources, each with a `.html` page and an `.svg` image: `architecture`, `message-intake`, `message-reply`, `message-lifecycle` and `personal-data` | Changes what a diagram shows. Edit only the `.json`, then regenerate. |

`docs/diagrams/*.delivery.json` receipts hold local absolute paths and are gitignored. Never force-add one.
