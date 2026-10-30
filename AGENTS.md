# AGENTS.md

Guidance for anyone — human or AI — working in this repository.

## Purpose

This repo builds a WhatsApp AI receptionist for Cumbident, a fictional dental studio, as an n8n workflow backed by Postgres. It is a portfolio demo: every file should read as production-quality, not a prototype.

## Repo map

- `compose.yaml`, `.env.example` — the local runtime: Postgres and n8n in Docker Compose, plus an optional ngrok tunnel.
- `db/schema.sql`, `db/init/` — the application database schema and the one-time role/database bootstrap script.
- `ngrok/traffic-policy.yml` — the tunnel's traffic policy (forwards webhook paths only).
- `config/config.example.json` — the config template; a developer's own `config/config.json` is gitignored.
- `scripts/manifest.ts` — the single source of truth for fixed workflow/credential IDs and the `CODE_NODES` table; `scripts/lib/` holds the shared workflow, runtime (Docker/`.env`), and dev-harness-client helpers.
- `scripts/check-workflows.ts`, `scripts/build-workflows.ts`, `scripts/export-workflows.ts`, `scripts/import-workflows.ts`, `scripts/setup-credentials.ts`, `scripts/dev-call.ts` — the workflow tooling CLIs; see Commands below.
- `src/nodes/` — one `run()` function per Code node, compiled into workflow JSON by `npm run build:workflows`; `src/nodes/shared/` holds logic more than one Code node reuses (e.g. `opening-hours.ts`); `src/globals.d.ts` declares the ambient `DateTime` those sources use.
- `tests/` — Vitest tests; `tests/fixtures/` holds workflow and Code-node fixtures, `tests/helpers/run-generated.ts` runs a generated Code node's output the way n8n's sandbox does.
- `tsconfig.json`, `eslint.config.ts`, `vitest.config.ts`, `package.json` — the TypeScript toolchain.
- `business/business.json`, `business/knowledge-base.md` — the business facts and FAQ prose the workflows read at runtime; `prompts/system-prompt.md` — the assistant's system prompt template (placeholders `<<BUSINESS>>`, `<<KNOWLEDGE_BASE>>`, `<<NOW>>`, `<<TRIAGE_NOTES>>`), checked by `tests/content.test.ts`.
- `workflows/` — the n8n workflow JSON, mounted read-only into n8n and imported by `npm run setup`. The four platform workflows (`load-context`, `error-handler`, `notify-team`, `dev-harness`) are in place; later tasks add the business sub-workflows and the WhatsApp entry point.
- `.n8n-import/` — created locally by the quick start; a scratch directory n8n's CLI reads credentials and workflows from, and the export tooling writes to. It's a live bind mount: never `rm -rf` it. If it breaks, `docker compose up -d --force-recreate n8n` recovers it without touching the named volumes.

## Commands

- `npm ci` — install dependencies from the lockfile.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — `eslint .`.
- `npm test` — `vitest run`.
- `docker compose up -d --wait` — start Postgres and n8n, and wait for both to report healthy.
- `docker compose --profile tunnel up -d --wait` — also start the ngrok tunnel (needs `NGROK_AUTHTOKEN` and `NGROK_DOMAIN`).
- `docker compose down` — stop the stack. Add `-v` to also drop the named volumes (destructive: wipes the database and n8n's data).
- `npm run build:workflows` — bundles each `src/nodes/*.ts` with esbuild into its Code node's `jsCode`, in the workflow file `scripts/manifest.ts`'s `CODE_NODES` names. Add `--check` to fail (exit 1) if the committed JSON doesn't match the source, without writing — that's what CI runs. After an esbuild update, run this and commit the regenerated JSON.
- `npm run check` — hygiene checks on every file in `workflows/`: pinned data, a literal email/phone/long id/secret, an unknown credential id, a hand-written or undocumented Code node, a missing required setting, an external-service node without retry on fail, and a Postgres query built from an expression instead of `$n` parameters.
- `npm run setup` — imports credentials (`scripts/setup-credentials.ts`) then publishes workflows (`scripts/import-workflows.ts`) into the local n8n instance. Skips a credential whose `.env` values are blank, or a Google Calendar/Sheets/Gmail credential that already exists (pass `--force` to overwrite one deliberately — it carries an interactive Google sign-in that `import:credentials` would otherwise wipe out). Skips a workflow not yet in `workflows/`, and holds back one whose trigger needs a credential that isn't available yet.
- `npm run export` — writes n8n's canonical form of every known workflow back to `workflows/` and regenerates their Code nodes; run this after editing a workflow in the n8n UI, and commit the result.
- `node scripts/dev-call.ts <target> '<json>'` — calls the dev-harness webhook (`POST {N8N_URL}/webhook/dev`) directly, for exercising a sub-workflow without WhatsApp. For example, `node scripts/dev-call.ts load-context '{}'` or `node scripts/dev-call.ts notify-team '{"reason":"other","phone":"570000000001"}'`. An unknown target answers `404 {"error":"unknown_target"}`; a request to the webhook without the `X-Dev-Token` header answers `403` (checked against n8n `2.45.6`). Two targets exist only in the dev harness, not as sub-workflow contracts: `find-patient '{"phone":...}'` looks a row up by exact phone and answers `{ "rows": [...] }`; `cleanup '{"phone_prefix":...}'` deletes a prefix's test data from Calendar, Sheets, and Postgres and is how later tasks reset state between scenario runs — it refuses any prefix that isn't 8 or more digits with `{"ok":false,"reason":"prefix_too_short"}` before touching anything, and reports `null` for any of its four parts that failed.
- n8n's `import:workflow`, `export:workflow`, `import:credentials`, `export:credentials`, and `publish:workflow` CLI commands need no owner account, `--userId`, or `--projectId` (checked against `2.45.6`). `publish:workflow` only takes effect after an n8n restart; `npm run setup` restarts n8n itself, but only when it actually published something, then waits for `/healthz`.

## Changing a workflow

1. Design the nodes and expressions against n8n's own node reference and real-world examples, especially for a node you haven't configured by hand before.
2. Edit the JSON in `workflows/` (fixed IDs and credential IDs come from `scripts/manifest.ts`), then run `npm run build:workflows` to regenerate any Code node it touches.
3. Validate the workflow JSON with an n8n-aware validation tool until it reports no errors.
4. Run `npm run setup` to import and publish it against the local n8n instance.
5. Run `npm run export` to write n8n's canonical form back to `workflows/` and regenerate Code nodes again. Commit that exported output, not your hand-edited JSON — the two can differ in server-assigned detail, and the exported form is what actually runs.
6. Run the full gate below before committing.

## Conventions

- Node 24 LTS, ESM (`"type": "module"`). `tsconfig.json` runs `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, and `allowImportingTsExtensions`, with `noEmit` — there is no build step.
- No `.js` or `.mjs` source files. Scripts are `scripts/*.ts`, run directly with `node scripts/<name>.ts` (Node's native type stripping; no `tsx`). Tests are Vitest files at `tests/**/*.test.ts`. The only JavaScript in the repo is the generated `jsCode` inside workflow JSON.
- CLIs call external programs with `execFile` or `spawn` and an argument array, never a shell string, and guard their entry point with `if (process.argv[1] === fileURLToPath(import.meta.url))` so tests can import their functions without side effects.
- Comments only where intent isn't obvious. A deliberate simplification gets one `NOTE:` line naming its ceiling and upgrade path. A deliberate lint or ShellCheck exception gets a one-line disable comment naming the reason.
- n8n workflow node names are actions (e.g. "Record inbound message"), and sticky notes label each section.
- Every node that calls an external service (Gmail, Google Calendar, Google Sheets, HTTP Request, Postgres, WhatsApp) sets Retry On Fail with 3 tries and a 1000 ms wait, unless a task says otherwise; `npm run check` enforces it. A node whose failure should be visible to the caller (rather than failing the whole run) sets `onError: "continueErrorOutput"` and wires its error output to a response that reports the failure, instead of swallowing it.
- No Code node is hand-written: each is `export function run(input) { ... }` in `src/nodes/<name>.ts` — pure, no I/O, no clock — compiled by `npm run build:workflows`; `npm run check` rejects any Code node not listed in `scripts/manifest.ts`'s `CODE_NODES`. Those sources use the ambient `DateTime` global (`src/globals.d.ts`) instead of importing Luxon, since the Code-node sandbox provides it but has no `require`; ESLint enforces that by banning `node:*` imports, `luxon`, `process`, and `fetch` in `src/nodes/**`.
- n8n's Code-node Task Runner (`@n8n/task-runner`) runs generated `jsCode` after setting `Object.defineProperty = () => ({})`, a sandbox hardening measure. esbuild's own IIFE output attaches every named export through that same function, so without a fix every export would silently vanish and `__node.run` would come back `undefined` — this broke the very first Code node this project ran for real (see `build-workflows.ts`'s `hardenAgainstFrozenDefineProperty`, which swaps esbuild's `__defProp` helper for a plain assignment). That rewrite is covered by a dedicated Vitest test that simulates the frozen sandbox; don't remove it when touching the build.

## Guardrails

- Secrets live only in `.env` (gitignored) and n8n credentials — never in code, workflow JSON, or committed config.
- Test data uses phone numbers with the `5700000000` prefix and emails on `example.com`; never a real person's data. The dev harness's `cleanup` target deletes by that same prefix across Calendar, Sheets, and Postgres (`starts_with`, never `LIKE`, so a non-digit or under-8-digit prefix is refused rather than silently matching everything).
- Everything in the repo is in English, except test inputs that deliberately exercise the assistant's Spanish replies (the triage fixture set and the `spanish-reply` scenario) — that Spanish text is intentional, not a rule violation.
- Database topology: role `n8n` owns database `n8n`, role `app` owns database `app`, and neither can connect to the other's database (`REVOKE ALL ... FROM PUBLIC`). The Postgres superuser exists only to bootstrap those roles in `db/init/`; it is never configured in the n8n container and should never reach it.
- n8n is pinned to `2.45.6`; never move to an unstable `3.x` tag before one is stable. Dependabot's automated updates for `n8nio/n8n` exclude minor and major bumps, because beta and stable releases share plain semver tags.
- Point tooling only at this repo's local n8n instance (`http://localhost:5678`), never another instance.
- No script prints credential data — `setup-credentials.ts` detects which credentials already exist in n8n from a CLI export, never a decrypted one, and only ever logs a credential's name, never its `data`.
- Any email sent to the team (e.g. `notify-team`, the error handler) is plain text, never HTML — so text a patient typed can't inject markup into a staff inbox.
- `scripts/export-workflows.ts`'s `normalizeWorkflow` strips fields n8n sets on export that reflect this instance's own history rather than the workflow's source (pinned data, timestamps, `active`, `versionCounter`, …). Importing and exporting the same workflows twice in a row must produce no diff; if n8n starts emitting a new such field, add it to that drop list and to its test.

## Definition of done

- `npm run typecheck && npm run lint && npm test && npm run build:workflows -- --check && npm run check` all pass locally — run this full gate before every commit that touches TypeScript.
- No secrets anywhere in the diff or git history; `.env` and `config/config.json` are never committed.
- `README.md` (Status, What works now, and the quick start if commands changed) and this file are updated to match what the change actually adds.
- Commits follow Conventional Commits, on a branch named `task-NN-<slug>`.

## PR checklist

- [ ] The gate above passes.
- [ ] Test data uses the `5700000000` phone prefix and `example.com`; no real person's data.
- [ ] Docs reflect the change.
- [ ] The PR description states what was verified (commands and their output) and lists any deferred live checks.
- [ ] The diff matches its task's brief — nothing extra, nothing missing.
