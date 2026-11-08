# AGENTS.md

Guidance for anyone — human or AI — working in this repository.

## Purpose

This repo builds a WhatsApp AI receptionist for Cumbident, a fictional dental studio, as an n8n workflow backed by Postgres. It is a portfolio demo: every file should read as production-quality, not a prototype.

## Repo map

- `compose.yaml`, `.env.example` — the local runtime: Postgres and n8n in Docker Compose, plus an optional ngrok tunnel.
- `compose.queue.yaml` — an optional override that adds Redis and `n8n-worker` containers for queue mode; see Commands.
- `db/schema.sql`, `db/init/` — the application database's baseline schema and the one-time role/database bootstrap script, both run only on an empty volume.
- `db/migrations/` — every schema change after that baseline, as an idempotent, numbered `NNN_short_name.sql` file that `pnpm run db:migrate` applies once and records in `schema_migrations`. [docs/database.md](docs/database.md#5-migrations) covers each file.
- `ngrok/traffic-policy.yml` — the tunnel's traffic policy: it forwards only the WhatsApp Trigger's own webhook path (`workflows/whatsapp-entry.json`'s `webhookId`) and rate-limits it per client IP. `tests/runtime.test.ts` pins it, along with `compose.yaml`'s `--inspect=false` for ngrok and n8n's 2 MiB body cap (`N8N_PAYLOAD_SIZE_MAX`).
- `config/config.example.json` — the config template; a developer's own `config/config.json` is gitignored.
- `scripts/manifest.ts` — the single source of truth for fixed workflow/credential IDs and the `CODE_NODES` table; `scripts/lib/` holds the shared workflow, runtime (Docker/`.env`), dev-harness-client, and scenario-grading (`scenarios.ts`) helpers.
- `scripts/check-workflows.ts`, `scripts/build-workflows.ts`, `scripts/export-workflows.ts`, `scripts/import-workflows.ts`, `scripts/setup-credentials.ts`, `scripts/dev-call.ts`, `scripts/run-scenarios.ts`, `scripts/init-env.ts`, `scripts/check-dev-response.ts`, `scripts/db-migrate.ts`, `scripts/check-db.ts` — the workflow and database tooling CLIs; see Commands.
- `src/nodes/` — one `run()` function per Code node, compiled into workflow JSON by `pnpm run build:workflows`. `src/nodes/shared/` holds logic several Code nodes reuse (`opening-hours.ts`, plus the language helpers in Languages), and `src/globals.d.ts` declares the ambient `DateTime`.
- `tests/` — Vitest tests, their fixtures, `tests/helpers/run-generated.ts` (runs a generated Code node the way n8n's sandbox does), and the scenario sets in `tests/scenarios/` that `scripts/run-scenarios.ts` grades. [docs/testing.md](docs/testing.md) lists every suite.
- `tsconfig.json`, `eslint.config.ts`, `vitest.config.ts`, `package.json` — the TypeScript toolchain.
- `business/business.json`, `business/knowledge-base.md`, `prompts/system-prompt.md` — the business facts (every fixed patient reply included, as `{ en, es }`), the FAQ prose, and the system prompt template (placeholders `<<BUSINESS>>`, `<<KNOWLEDGE_BASE>>`, `<<NOW>>`, `<<LANGUAGE>>`, `<<TRIAGE_NOTES>>`) the workflows read at runtime; `tests/content.test.ts` checks them.
- `workflows/` — the n8n workflow JSON, mounted read-only into n8n and imported by `pnpm run setup`: the platform workflows (`load-context`, `error-handler`, `notify-team`, `dev-harness`), the business tools (`check-availability`, `upsert-patient`, `book-appointment`), `triage-message`, `process-message` (the core every patient message runs through), `whatsapp-entry` (the WhatsApp webhook entry point), and `retention-cleanup` (the daily retention job). [docs/architecture.md](docs/architecture.md#what-each-component-does) describes each.
- `docs/` — the documents in the Documentation map below. Update `database.md` when a change adds a query, a table, a grant, or a migration; `red-team.md` when it adds a model input, a tool, a tool field the model fills, or a guard; `architecture.md` when it alters a component, the message lifecycle, the data model, a failure mode, scaling, security, or a design decision; and `testing.md` when it adds or removes a test file, a suite, or a CI step.
- `docs/diagrams/` — the architecture and message-sequence diagrams. Edit only each `*.json` source, then regenerate its `*.html` page and `*.svg` export (see Commands).
- `.n8n-import/` — the scratch bind mount `pnpm run export` writes to, created by `node scripts/init-env.ts`. It's live, so never `rm -rf` it; [docs/architecture.md](docs/architecture.md#security-and-data-handling) covers its recovery and why no credential crosses it.

## Documentation map

| Document | Covers |
|---|---|
| [`README.md`](README.md) | What the project does, its status, the quick start, the upgrade steps, and the pending live checks. |
| [`docs/architecture.md`](docs/architecture.md) | The components, the ten-step message lifecycle, the data model, failure modes with recovery steps, known limits, scaling, security, the design decisions, and how to regenerate the diagrams. |
| [`docs/database.md`](docs/database.md) | The database roles and grants, every statement the workflows issue with its grant and index, migrations, retention, backup and restore, connections, the upgrade path for an existing volume, and what `node scripts/check-db.ts` proves. |
| [`docs/red-team.md`](docs/red-team.md) | Where a patient's text reaches a model, every adversarial input with its expected behavior and guard, how to run those inputs live, and the questions only a live run answers. |
| [`docs/testing.md`](docs/testing.md) | Every test suite: its command, what it covers, and how it stays deterministic, plus the stack checks, the dev-harness targets, the scenario and red-team suites, what CI runs, and the deferred live checks. |
| [`docs/diagrams/architecture.json`](docs/diagrams/architecture.json) | The system diagram's archify source (type `architecture`): WhatsApp → ngrok → `whatsapp-entry` → `process-message` → AI Agent, with `triage-message`, `notify-team`, `retention-cleanup`, Postgres, Google, Anthropic, and TypeSafe. |
| [`docs/diagrams/architecture.html`](docs/diagrams/architecture.html) | The system diagram's interactive page, rendered by archify. Open it in a browser to pan, search, and inspect each node. |
| [`docs/diagrams/architecture.svg`](docs/diagrams/architecture.svg) | The system diagram's exported image, which follows the reader's light or dark theme; embedded in `docs/architecture.md` and the README. |
| [`docs/diagrams/message-sequence.json`](docs/diagrams/message-sequence.json) | The message-lifecycle sequence diagram's archify source (type `sequence`): signature check, normalize, record and dedupe, language and rate limit, triage, route, agent with tool calls (including the two-pass booking), reply check, reply, and mark replied. |
| [`docs/diagrams/message-sequence.html`](docs/diagrams/message-sequence.html) | The sequence diagram's interactive page. |
| [`docs/diagrams/message-sequence.svg`](docs/diagrams/message-sequence.svg) | The sequence diagram's exported image, embedded in `docs/architecture.md`. |

`docs/diagrams/*.delivery.json` receipts, which some archify versions write on `deliver`, hold local absolute paths and are gitignored; never force-add one.

## Commands

- `pnpm install --frozen-lockfile` — install dependencies from the lockfile.
- `pnpm run typecheck` — `tsc --noEmit`.
- `pnpm run lint` — `eslint .`.
- `pnpm test` — `vitest run`. [docs/testing.md](docs/testing.md) lists every suite and what it covers.
- `docker compose up -d --wait` — start Postgres and n8n, and wait for both to report healthy.
- `docker compose --profile tunnel up -d --wait` — also start the ngrok tunnel (needs `NGROK_AUTHTOKEN` and `NGROK_DOMAIN`).
- `docker compose down` — stop the stack. Add `-v` to also drop the named volumes (destructive: wipes the database and n8n's data).
- `docker compose -f compose.yaml -f compose.queue.yaml up -d --wait --scale n8n-worker=2` — switch to queue mode: Redis plus the given number of `n8n-worker` containers, which run executions instead of the main process. [docs/architecture.md](docs/architecture.md#scaling-limits-and-what-to-change) covers how the worker extends `n8n`.
- `docker compose -f compose.yaml -f compose.queue.yaml down && docker compose up -d --wait` — return to the regular, single-process stack. Plain `down`, with no `-v`, keeps the named volumes.
- `pnpm run build:workflows` — bundles each `src/nodes/*.ts` with esbuild into the `jsCode` of the Code node `CODE_NODES` names; add `--check` to fail (exit 1) without writing when the committed JSON doesn't match, as CI does. After an esbuild update, run it and commit the regenerated JSON.
- `pnpm run check` — hygiene checks on every file in `workflows/`; [docs/testing.md](docs/testing.md#build-and-hygiene-commands) lists what it rejects.
- `pnpm run db:migrate` — applies each pending `db/migrations/` file in its own transaction as the Postgres superuser, then resets `app_runtime`'s password and attributes from `.env`; it stops before touching the database on a bad file or a missing variable, and a second run prints `no pending migrations`. [docs/database.md](docs/database.md#5-migrations) has the steps and how no secret reaches an argument list or the server log.
- `pnpm run setup` — runs `db:migrate`, imports credentials (`scripts/setup-credentials.ts`), then publishes workflows (`scripts/import-workflows.ts`) into the local n8n. It skips a credential with blank `.env` values, an existing Google Calendar/Sheets/Gmail credential (`node scripts/setup-credentials.ts --force` overwrites it, signing it out; see the README's upgrade steps), a workflow not yet in `workflows/`, and one whose trigger credential isn't available.
- `pnpm run export` — writes n8n's canonical form of every known workflow back to `workflows/` and regenerates their Code nodes; run this after editing a workflow in the n8n UI, and commit the result.
- `pnpm run scenarios -- --triage` — scores the 17 English/Spanish messages in `tests/scenarios/triage.json` through `triage-message` and prints a `| lang | signal | correct/total |` table. It needs a real TypeSafe credential; without one, every score is `null` and every row reads 0.
- `pnpm run scenarios` — the triage table, then every multi-turn conversation in `tests/scenarios/conversations.json` through `process-message`, printed as a `| id | result | details |` table; it exits 1 only when a conversation is `FAIL`. [docs/testing.md](docs/testing.md#scenario-suites) covers the checks, `cleanup` around the batch, and `SKIP`.
- `pnpm run scenarios -- --only <id>` — runs one conversation scenario by id instead of the full batch, e.g. `pnpm run scenarios -- --only hours`.
- `pnpm run scenarios -- --tool-failure` — runs one more scenario, kept out of `conversations.json`, that points `config.google.calendar_id` at an invalid id to exercise `check-availability`'s `calendar_unavailable` path and its team alert. It backs up and restores `config/config.json`, even on failure, and never prints it.
- `node scripts/dev-call.ts <target> '<json>'` — calls the dev-harness webhook (`POST {N8N_URL}/webhook/dev`, `X-Dev-Token` required) to exercise a sub-workflow without WhatsApp, e.g. `node scripts/dev-call.ts load-context '{}'`. [docs/testing.md](docs/testing.md#the-dev-harness) lists the targets and their answers.
- `node scripts/init-env.ts` — writes `.env` from `.env.example`, filling only the local-stack and dev-harness secrets with random hex and leaving every third-party value blank; it refuses to run if `.env` exists. The quick start and CI (which has no repo secrets) both run it.
- `node scripts/check-dev-response.ts` — asserts the exact answers of two credential-free dev-harness calls, `retention` and a past-date `check-availability`, and exits 1 on the first mismatch. CI's `n8n` job uses it to prove n8n runs both a plain node path and a generated Code node.
- `node scripts/check-db.ts` — runs psql in the `postgres` container and prints `ok` or `FAIL` per check of `app_runtime`'s denials and exact grants, every workflow statement, and the migration ledger, exiting 1 on any failure. [docs/database.md](docs/database.md#proving-it-check-db) lists the checks.
- Regenerate a diagram after you edit its source in `docs/diagrams/`, with [archify](https://github.com/tt-a1i/archify)'s 2.17 skill package (`2.17.0-dev.1`) kept outside the repo. [docs/architecture.md](docs/architecture.md#regenerating-the-diagrams) has the validate, deliver, export, and visual-check steps.
- n8n's `import:workflow`, `export:workflow`, `import:credentials`, `export:credentials`, and `publish:workflow` CLI commands need no owner account, `--userId`, or `--projectId` (checked against `2.45.6`). `publish:workflow` only takes effect after an n8n restart, which `pnpm run setup` does only when it published something; see "Changing a workflow".

## Changing a workflow

1. Design the nodes and expressions against n8n's own node reference and real-world examples, especially for a node you haven't configured by hand before.
2. Edit the JSON in `workflows/` (fixed IDs and credential IDs come from `scripts/manifest.ts`), then run `pnpm run build:workflows` to regenerate any Code node it touches.
3. Validate the workflow JSON with an n8n-aware validation tool until it reports no errors.
4. Run `pnpm run setup` to import and publish it against the local n8n instance.
5. Run `pnpm run export` to write n8n's canonical form back to `workflows/` and regenerate Code nodes again. Commit that exported output, not your hand-edited JSON — the two can differ in server-assigned detail, and the exported form is what actually runs.
6. Run the full gate below before committing.

After any restart of the `n8n` container, wait 15 s before calling a workflow: `/healthz` turns healthy before the publication reconciler (every 10 s by default) registers the new webhook routes. `pnpm run setup` waits those 15 s itself, then polls `dev-harness`'s webhook until it stops answering 404, failing after 60 s (`waitForWebhookLive` in `scripts/lib/runtime.ts`).

## Conventions

- Node 24 LTS, ESM (`"type": "module"`). `tsconfig.json` runs `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, and `allowImportingTsExtensions`, with `noEmit` — there is no build step.
- No `.js` or `.mjs` source files: scripts are `scripts/*.ts`, run with `node scripts/<name>.ts` (Node's native type stripping; no `tsx`), and tests are Vitest files at `tests/**/*.test.ts`. The only JavaScript in the repo is the generated `jsCode` inside workflow JSON.
- CLIs call external programs with `execFile` or `spawn` and an argument array, never a shell string, and guard their entry point with `if (process.argv[1] === fileURLToPath(import.meta.url))` so tests can import their functions without side effects.
- Comments only where intent isn't obvious: a deliberate simplification gets one `NOTE:` line naming its ceiling and upgrade path, and a deliberate lint or ShellCheck exception a one-line disable comment naming the reason. A comment, doc, or sticky note states its own reason, never a plan task, a ruling, or a review finding's ID; `tests/hygiene.test.ts` scans every tracked file except lockfiles, generated diagram pages, and binaries for them.
- n8n workflow node names are actions (e.g. "Record inbound message"), and sticky notes label each section.
- Every node that calls an external service (Gmail, Google Calendar, Google Sheets, HTTP Request, Postgres, WhatsApp) sets Retry On Fail with 3 tries and a 1000 ms wait, except the two exceptions in the architecture doc's design decisions (Jev's 2 tries, the WhatsApp send's 2000 ms wait); `pnpm run check` enforces it. A node whose failure the caller should see sets `onError: "continueErrorOutput"` and wires its error output to a response that reports the failure, instead of swallowing it.
- `load-context` never names an error workflow; its callers keep theirs, so a failure while loading context still alerts. The error handler calls `load-context` for `config.team_email`, and n8n guards only against a workflow naming itself as its own error workflow, so a missing or unparseable mounted file would otherwise loop the two forever.
- No Code node is hand-written: each is a pure `export function run(input) { ... }` in `src/nodes/<name>.ts` (no I/O, no clock), compiled by `pnpm run build:workflows`, and `pnpm run check` rejects one not in `CODE_NODES`. Those sources use the ambient `DateTime` (`src/globals.d.ts`), since the sandbox provides Luxon but no `require`, and ESLint bans `node:*` imports, `luxon`, `process`, and `fetch` in `src/nodes/**`.
- SQL comments never contain `$n`: n8n replaces every `$` followed by a digit in a query's text, comments included, before it reaches Postgres. `pnpm run check` rejects a query with one.
- Postgres nodes are typeVersion 2.8 or later wherever a Query Parameters expression can carry text (checked against `2.45.6`): 2.5–2.7 split a string result on commas unless it parses as JSON, so "Hi, I'd like a cleaning, please" would become three values. An n8n-aware validator whose node database tops out at 2.7 flags 2.8 as unknown; that's the tool lagging the pinned n8n, not a workflow error.
- An AI Agent with `onError: "continueErrorOutput"` uses its error output only for failures inside a run; one that fails before, such as a model sub-node with a missing credential, sends its input item out of the success output. Follow the agent with a reply-text check, as `process-message`'s "Did the agent reply" does, and treat both paths as the failure.
- n8n's Code-node Task Runner disables `Object.defineProperty`, which esbuild's output relies on; `build-workflows.ts`'s `hardenAgainstFrozenDefineProperty` works around it, and a Vitest test that simulates the frozen sandbox covers it. Don't remove either when touching the build.

## Languages

Patients get every fixed reply in English or Spanish, and the team gets its emails in one language of its choosing. English is the source language: every key and default string is written in English first, and Spanish is a translation of it.

- **Patient replies.** `process-message`'s `Resolve language` (`src/nodes/resolve-language.ts`) resolves `lang` once per new message: `detectLanguage(text)` (`src/nodes/shared/detect-language.ts`, a deterministic word count the architecture doc's design decisions describe), or `config.locale.default` when it can't tell or the message isn't text. Every fixed reply picks `business.replies.<key>[lang]`, `Check reply` writes its booking confirmation in `lang`, and `Build system prompt` fills `<<LANGUAGE>>` with a hint; the agent still answers in the language the patient is writing in.
- **Team emails.** `notify-team`'s `Compose alert` and `error-handler`'s `Compose error email` read their labels and alert reasons from `TEAM_MESSAGES` in `src/nodes/shared/team-messages.ts`, picked by `config.team_locale`. What a patient, the agent, or n8n wrote stays as written, and the email stays plain text.
- **Config.** `config.locale.default` (the patients' fallback, `"es"` in the example) and `config.team_locale` (`"en"` in the example) each take `en`, `es`, or any locale `normalizeLocale` (`src/nodes/shared/locale.ts`) reduces to one, such as `es-CO` or `en_US`; a config without either setting falls back to English. Neither ever stops a run: an unsupported `locale.default` counts as English, and an unsupported `team_locale` sends team emails in English with a line saying so.
- **Service names.** Each service in `business/business.json` keeps its English `name` as the canonical key every tool call, Calendar event, and price lookup uses, plus a `name_i18n` display name per language. The agent's tool descriptions ask for the canonical name, and `validate-booking` maps a translated name back to it in case the model sends one anyway.
- **Switching languages.** Edit `config/config.json`; n8n reads it on every run, so no import or restart is needed. To change what a reply says, edit both of its values in `business/business.json`.
- **Adding a language**, for example Portuguese:
  1. Add `'pt'` to `Lang` and `LANGS` in `src/nodes/shared/locale.ts`, and let `normalizeLocale` accept it.
  2. Add a `pt` value to every reply and every service's `name_i18n` in `business/business.json`, a `pt` entry to `TEAM_MESSAGES`, to `check-reply.ts`'s `CONFIRMATIONS`, and to `build-system-prompt.ts`'s `LANGUAGE_NAMES`. `tsc` flags every `Record<Lang, …>` table still missing it, and `tests/content.test.ts` and `tests/nodes/team-messages.test.ts` fail on any reply or message missing or empty.
  3. Teach `detect-language.ts` the new language's signals and decide how it ranks against the others; add its cases to `tests/nodes/detect-language.test.ts`.
  4. Run `pnpm run build:workflows` and the full gate, and commit the regenerated workflow JSON.

## Guardrails

- Secrets live only in `.env` (gitignored) and n8n credentials — never in code, workflow JSON, or committed config.
- Test data uses phone numbers with the `5700000000` prefix and emails on `example.com`; never a real person's data. The dev harness's `cleanup` target deletes by that prefix with `starts_with`, never `LIKE`, and refuses a non-digit or under-8-digit prefix rather than match everything.
- Everything in the repo is in English, except the Spanish translations (each `es` value in `business.json`'s `replies` and in the `{ en, es }` tables in `src/nodes/`), the Spanish word list language detection scores, and test inputs that deliberately exercise Spanish (the triage fixtures, the Spanish conversation scenarios, and the adversarial inputs `docs/red-team.md` lists). No other Spanish string belongs in source logic.
- Every Postgres node connects through the `App DB` credential as `app_runtime` (DML on named tables only), except the Postgres Chat Memory node, which runs `CREATE TABLE IF NOT EXISTS` and so connects as the owner `app` through `App DB (chat memory)`; `tests/tooling.test.ts` pins it as that credential's only user. The Postgres superuser exists only for `db/init/` and `db-migrate` and never reaches the n8n container, and a new table gets its grants in its own migration, never through default privileges; [docs/database.md](docs/database.md#roles) has the full topology.
- Every workflow sets `settings.saveManualExecutions: false`, with no per-workflow exception, and `tests/workflows/execution-data.test.ts` asserts it; [docs/database.md](docs/database.md#6-retention) explains why.
- n8n is pinned to the `2.45` line, by digest: patch releases arrive through Dependabot once CI's `n8n` job passes on them, and `tests/runtime.test.ts` rejects any other line. Never move to an unstable `3.x` tag before one is stable. Dependabot's automated updates for `n8nio/n8n` exclude minor and major bumps, because beta and stable releases share plain semver tags.
- Point tooling only at this repo's local n8n instance (`http://localhost:5678`), never another instance.
- No script prints credential data: `setup-credentials.ts` logs only a credential's name, detects existing credentials from the encrypted export rather than a decrypted one, and moves credentials only over stdin and stdout, never through the host filesystem or `.n8n-import/`.
- Every team email (each Gmail node, as in `notify-team` and `error-handler`) is plain text with no sender name, and every Google Sheets write stores values raw (`cellFormat: RAW`), so a patient's text can't inject markup into a staff inbox or a formula into the Patients sheet. A sender name makes n8n's Gmail node read the account profile, which the send-only scope doesn't allow; `tests/workflows/injection-guards.test.ts` pins all three.
- Agent tools never take the phone from the model: each tool node maps `phone` from the trigger (`$('When called').first().json.phone`) and maps or removes every sub-workflow input the model shouldn't fill, since unmapped fields get the model's raw arguments; `tests/workflows/process-message.test.ts` pins both against an allowlist. `notify_team`'s `reason` is clamped to `unknown_treatment`, `out_of_scope`, or `other`, because `notify-team` exempts `tool_failure` from its per-phone cooldown and holds back an `emergency` only after an earlier emergency.
- `scripts/export-workflows.ts`'s `normalizeWorkflow` strips fields n8n sets on export that reflect this instance's history rather than the workflow's source (pinned data, timestamps, `active`, `versionCounter`, …). Importing and exporting twice in a row must produce no diff; if n8n starts emitting a new such field, add it to that drop list and its test.

## Supply-chain hardening

Package management is pnpm, pinned in `package.json`'s `packageManager` to an exact `11.x` version; never move to pnpm 12 (Dependabot's dependency-graph parser does not yet read its default two-document lockfile). `pnpm-workspace.yaml` holds the settings pnpm 11 no longer reads from `.npmrc`, each with a one-line reason:

- `minimumReleaseAge: 4320` refuses any package version (transitive included) published less than 3 days ago, giving a compromised release time to be caught and pulled, and `minimumReleaseAgeExclude: []` overrides pnpm 11's default `n8n`/`n8n-*`/`@n8n/*` exemption, so nothing is exempt.
- `trustPolicy: no-downgrade`, `blockExoticSubdeps: true`, `strictDepBuilds: true` with `dangerouslyAllowAllBuilds: false`, and `engineStrict: true` fail an install on regressed trust evidence (the pinned pnpm's own included), a transitive git or tarball dependency, an unapproved build script, or an `engines` range that excludes this repo's Node.
- `allowBuilds` lists only packages a real `pnpm install --frozen-lockfile` proved need their build script, each with a one-line reason; `esbuild: true` is the one entry. Add another only after the same proof.

`tests/supply-chain.test.ts` reads these back through pnpm's effective config, so a misspelled key fails it; [docs/testing.md](docs/testing.md#unit-and-workflow-tests-vitest) lists its other checks.

**Updating a dependency:** edit `package.json`, run `pnpm install` (not `--frozen-lockfile`) to update `pnpm-lock.yaml`, run the gate below, and commit both files together. `minimumReleaseAge` will refuse a version published too recently — that's a feature, not a bug to work around; wait it out or pin an older compatible version.

**Landing a security fix younger than the 3-day gate:**
1. Add a temporary entry to `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`, scoped to that one package and version (`name@version`, e.g. `"esbuild@0.28.3"`; a bare name would exempt every future version too), with a `#` comment naming the advisory ID and today's date.
2. Run `pnpm install` and merge as usual.
3. Remove the entry once that version is older than 3 days.

`tests/supply-chain.test.ts` asserts `minimumReleaseAgeExclude` is empty, so it goes red at step 1 on purpose, as the reminder for step 3; let it stay red for that one PR rather than weaken the assertion. If that would make CI unmergeable, wait out the 3-day gate instead.

**Images** (`compose.yaml`, `compose.queue.yaml`) are pinned `name:tag@sha256:<digest>`, the multi-arch index digest from `docker buildx imagetools inspect name:tag`, so one reference resolves on both arm64 (local) and amd64 (CI). Dependabot keeps an existing digest current but won't add a missing one, so a tag bump needs its digest re-resolved the same way and the tag reviewed by hand first.

**CI tool images and zizmor** are pinned the same way, by hand, because Dependabot reads neither a `docker run` line nor `.github/zizmor-requirements.txt`. Bump a tool image by reviewing the new tag and replacing its whole `name:tag@sha256:<digest>` reference in `.github/workflows/ci.yml`; bump zizmor as that requirements file's header says.

**CI** installs with `pnpm/setup` (pinned by commit SHA) then `actions/setup-node` with `cache: pnpm`, then `pnpm install --frozen-lockfile`, then `pnpm audit --audit-level=high`.

**The `n8n` job** (`.github/workflows/ci.yml`) is the one job that boots the real stack and proves a workflow executes — a plain node path and a generated Code node — not just that the committed JSON is well-formed; it needs no CI-only permissions step, since no credential data touches the `.n8n-import/` bind mount. [docs/testing.md](docs/testing.md#what-ci-runs) lists its steps and what CI doesn't run, and why.

**Dependabot** (`.github/dependabot.yml`) adds a 7-day cooldown to every ecosystem: `npm` (which covers the pnpm lockfile) gets 14 days for major and 7 for minor and patch, and `docker-compose` and `github-actions` a flat `default-days: 7`, since neither has a universal semver convention. Every version PR is therefore past pnpm's 3-day install gate, while security updates still arrive immediately.

## Branches and pull requests

- `main` holds released code and is the default branch; `develop` is the integration branch. Both take changes only through a pull request with CI green, and repository rulesets block direct pushes, force pushes, and deletion.
- Work on a short-lived branch from `develop` (`feat/…`, `fix/…`, `docs/…`, `chore/…`) and open the pull request into `develop`, titled in Conventional Commits form. It's squash-merged, so the title becomes the commit.
- A release is a pull request from `develop` into `main`, merged with a merge commit, then tagged `vX.Y.Z` with a GitHub release.
- Dependabot opens its pull requests against `develop`.

## Definition of done

- `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build:workflows -- --check && pnpm run check` all pass locally — run this full gate before every commit that touches TypeScript.
- No secrets anywhere in the diff or git history; `.env` and `config/config.json` are never committed.
- `README.md` (Status, What works now, and the quick start if commands changed) and this file are updated to match what the change actually adds.
- Commits follow Conventional Commits.

## PR checklist

- [ ] The gate above passes.
- [ ] Test data uses the `5700000000` phone prefix and `example.com`; no real person's data.
- [ ] Docs reflect the change.
- [ ] The PR description states what was verified (commands and their output) and lists any deferred live checks.
- [ ] The diff matches what the PR description says — nothing extra, nothing missing.
