# Test suites

This page lists every test suite in the repo: its command, what it covers, and how it stays deterministic and clean. It then covers the checks that need the local Docker stack, the scenario and red-team suites that need real credentials, what continuous integration (CI) runs, and the live checks still deferred.

## Unit and workflow tests (Vitest)

**Command:** `pnpm test` (`vitest run`, config `vitest.config.ts`, which includes `tests/**/*.test.ts` and loads `tests/setup.ts` first).

**Code-node sources** (`tests/nodes/`), one file per `src/nodes/` module:

- `build-system-prompt.test.ts` — every placeholder filled, triage notes one per line, text inserted verbatim, the TEAM ALERTED note only after a sent alert, and the language hint: a detected language named as this message's, an undetected one naming the default without claiming the patient wrote in it.
- `check-reply.test.ts` — the reply check: each dose, dosing-interval, and medicine pattern (brands common in Colombia and classes included, whole words only) gets the fixed `medical_advice` reply; an unlisted peso amount or a discount gets `price_check`; listed prices, plain numbers, hours, dates, and the address are kept; one confirmation line per booking made that turn, in the business timezone and the message's language; English fallback for a missing or unsupported language.
- `collect-tool-calls.test.ts` — the agent's intermediate steps become `tool_calls`, with JSON observations parsed.
- `compute-free-slots.test.ts` — `check-availability`'s slot logic: Sunday closed, past and invalid dates, minimum notice, busy and all-day events, Saturday hours, and an empty calendar.
- `count-cleanup-outcomes.test.ts` — the dev harness's `cleanup` count, `null` on any failure.
- `decide-route.test.ts` — triage thresholds: fail open on missing or out-of-range scores, `blocked` overriding everything, inclusive thresholds, which alert reason wins, and a missing or invalid threshold failing the run instead of turning its signal off.
- `detect-language.test.ts` — the deterministic language check, including names never deciding the language and every triage fixture and conversation turn resolving to its declared language.
- `locale.test.ts` — `normalizeLocale` and the fallback rules for a missing, supported, or unsupported setting.
- `resolve-language.test.ts` — `Resolve language`: a message that shows its language, a non-text message, an old config without the locale settings, an unsupported `locale.default`, and that `team_locale` never matters here.
- `team-messages.test.ts` — every team label and alert reason in both languages, the alert and failure emails in English and Spanish, and a missing or invalid `team_locale` still sending in English with a line saying so.
- `validate-booking.test.ts` — every `book-appointment` rejection before any Calendar call (unknown service, missing name, bad time, closed day, outside hours, past, too soon, off the slot grid, past the horizon, at the per-phone limit), a translated service name mapped back to its canonical one, and missing booking limits failing with a fixed message.

**Workflow JSON** (`tests/workflows/`), reading the committed files in `workflows/`:

- `book-appointment.test.ts` — no node reads another through item pairing, an invalid request or a missing limit stops before Calendar, the limit counts only this phone's events, and the slot recheck queries exactly `[start, end)`.
- `check-availability.test.ts` — `Get busy events` is the Google Calendar node.
- `error-handler.test.ts` — the failure email comes from the generated `Compose error email`, and writes a Spanish email inside a sandbox that freezes `Object.defineProperty`.
- `execution-data.test.ts` — every workflow sets `saveManualExecutions: false`.
- `injection-guards.test.ts` — every Gmail node sends plain text with no sender name, and every Sheets write stores values raw.
- `load-context.test.ts` — `load-context` names no error workflow, and `error-handler` calls nothing that could call it back.
- `notify-team.test.ts` — the cooldown wiring and query, the emergency rule, a sent alert recorded with its reason, an invalid `alert_cooldown_minutes` stopping the run, and the generated `Compose alert` writing a Spanish alert in the frozen sandbox.
- `process-message.test.ts` — each tool takes the phone from the trigger and lets the model fill only its allowlisted fields, the AI Agent never retries, the chat model's settings, one value per Postgres parameter, the handoff mark, the TEAM ALERTED rule, every reply passing `Check reply`, `Resolve language` right after the duplicate check, and the generated `Check reply` and `Resolve language` nodes running in the frozen sandbox.
- `retention-cleanup.test.ts` — both deletes reachable only through the `retention_days` guard, in order, with Always Output Data, and the guard's error naming the bad setting.
- `whatsapp-entry.test.ts` — one `process-message` run per trigger item, the send's recipient and phone number id, and `Mark replied` only after a successful send.

**Tooling, content, and repo rules** (`tests/*.test.ts`):

- `tooling.test.ts` — the hygiene checker against `tests/fixtures/workflows/` (`clean.json`, plus one defect per other fixture), the Code-node build and its frozen-`defineProperty` hardening, `normalizeWorkflow`, the credential manifest and import plan (the Gmail send-only scope, the runtime and owner database roles, existing Google credentials skipped unless forced, credentials only over stdin), and which trigger credentials hold back publishing.
- `check-db.test.ts` — `scripts/check-db.ts`'s predicates (`isDenied`, `diffGrants`, `roleProblems`), its psql quoting, and one probe per Postgres statement in `workflows/`, so a new query can't skip the check.
- `check-dev-response.test.ts` — the two exact responses `scripts/check-dev-response.ts` accepts.
- `db-migrate.test.ts` — migration ordering and naming, pending-file choice, `\getenv` extraction, the transaction-control and role-name-clash guards, the advisory lock, the `schema_migrations` record, and keeping passwords out of the server log and argument lists.
- `init-env.test.ts` — `scripts/init-env.ts`'s generated secrets, its atomic 0600 `.env` write, the `.n8n-import/` directory, and that `.env.tmp` is gitignored.
- `lib-runtime.test.ts` — `execFileWithInput`'s stdin handling and the webhook-readiness poll behind `pnpm run setup`.
- `content.test.ts` — the business facts, the knowledge base, the system prompt's placeholders and rules, and every fixed reply present in English and Spanish.
- `runtime.test.ts` — `compose.yaml` and `.env.example` agree, images are pinned, n8n never sees the Postgres superuser, the tunnel policy and payload cap, and `config/config.example.json`'s values.
- `scenarios-lib.test.ts` — the scenario grader (`triageAccuracy`, `checkTurn`, `nextWeekday`) and the conversation fixtures' ids, phones, and patterns, including the adversarial ones.
- `supply-chain.test.ts` — pnpm's effective supply-chain config, the exact pnpm 11 pin, no `package-lock.json` or `npm` instructions, digest-pinned images, `no-new-privileges` and dropped capabilities, and hash-pinned zizmor.
- `hygiene.test.ts` — no tracked file points at a plan task, a brief, a ruling, or a review finding instead of stating its reason.

`tests/helpers/run-generated.ts` isn't a test file: it runs a generated Code node's `jsCode` the way n8n's sandbox does, for the workflow and tooling tests above. `tests/fixtures/nodes/double-value.ts` is the one-line Code-node source the build tests compile.

**Staying deterministic and clean:**

- No test opens a network connection or needs Docker. The webhook-readiness poll gets a fake `fetch`, and the one test that would call `docker compose` (`existingCredentialIds` in `tooling.test.ts`) mocks `scripts/lib/runtime.ts`'s `compose`.
- Code-node sources never read the clock: each takes `now` as input, so every test passes a fixed instant. `tests/setup.ts` provides the ambient `DateTime` global the sandbox exposes, from the same Luxon the sources are typed against.
- Generated nodes are tested twice: as TypeScript, and as the committed `jsCode`, inside a sandbox that freezes `Object.defineProperty` like n8n's Task Runner.
- Only `init-env.test.ts` and `tooling.test.ts` write files, each to a fresh `mkdtempSync` directory under the OS temp dir, never the repo. A few tests run read-only commands: `git ls-files`, `git check-ignore`, and `pnpm config list --json`; `lib-runtime.test.ts` spawns plain local commands to prove its stdin handling.
- No test reads `.env` or `config/config.json`; they read the committed `.env.example` and `config/config.example.json` instead.

## Build and hygiene commands

CI runs these directly, not through a test file:

- `pnpm run typecheck` and `pnpm run lint` — `tsc --noEmit` and ESLint (with `eslint-plugin-security`) over the repo.
- `pnpm run build:workflows -- --check` — fails if a Code node's committed `jsCode` doesn't match a fresh build of its `src/nodes/*.ts` source.
- `pnpm run check` — the hygiene checker against `workflows/` itself: pinned data, literal secrets, unknown credential ids, undocumented or hand-written Code nodes, required settings, retries on external calls, and Postgres queries built from expressions.

## Stack checks (Docker)

**Commands:** `docker compose up -d --wait postgres n8n`, `pnpm run setup`, then `node scripts/check-db.ts` and `node scripts/check-dev-response.ts`. Tear down with `docker compose down`; add `-v` only for a disposable stack.

- `node scripts/check-db.ts` — runs psql inside the `postgres` container. As `app_runtime`, DDL, `TRUNCATE`, connecting to `n8n`, and `SET ROLE` to the owner are all denied with the exact expected error; its privileges equal the grant list; every workflow's SQL runs under it inside a rolled-back transaction; and `schema_migrations` records every migration. [docs/database.md](database.md#proving-it-check-db) has the details.
- `node scripts/check-dev-response.ts` — two dev-harness calls with exact expected answers: `retention` (a plain Postgres path) and `check-availability` with a past date (rejected by the generated `Check date` node before any Calendar call). Neither needs a third-party credential.

**Staying deterministic and clean:** both scripts need only the generated `.env` and the example config. `check-db` rolls back every probe, and `check-dev-response` uses a fixed past date and the `retention` target, which deletes only expired rows.

## Scenario suites

These call the real models through the dev harness, so they need `N8N_URL`, `DEV_HARNESS_TOKEN`, and real credentials. CI doesn't run them.

- `pnpm run scenarios -- --triage` — sends each of the 17 English and Spanish messages in `tests/scenarios/triage.json` to `triage-message` and prints a `| lang | signal | correct/total |` table. It never fails the run, and without a TypeSafe credential every score is `null` and counts as wrong.
- `pnpm run scenarios` — the triage table, then the 20 multi-turn conversations in `tests/scenarios/conversations.json` through `process-message`, each turn checked against its route, tools, reply text, and tool input and output. It exits 1 on any `FAIL`; a scenario that needs tomorrow open prints `SKIP` on a Sunday in America/Bogota.
- `pnpm run scenarios -- --only <id>` — one conversation, such as `hours`.
- `pnpm run scenarios -- --tool-failure` — one more scenario that points `config.google.calendar_id` at an invalid id to exercise `calendar_unavailable` and its team alert. It backs up `config/config.json` first and restores it afterward.

**Staying deterministic and clean:** relative dates such as `{{next_thursday}}` resolve from the run's own date in America/Bogota. Every scenario uses its own `5700000000` test phone, and the harness's `cleanup` target deletes that prefix's Calendar events, sheet rows, and Postgres rows before and after the batch. Without real credentials, every conversation reports `FAIL` with route `fallback`; that's the expected offline result, not a regression.

## Red-team suite

[docs/red-team.md](red-team.md) maps each adversarial input to the guard that handles it. Nine of the conversations above are its live checks: `instruction-override`, `prompt-extraction`, `other-patient-data`, `booking-limit`, `fake-discount`, `dose-request`, `classifier-injection`, `context-poisoning`, and `cancellation`. Their deterministic guards are already covered by the Vitest suites above (`check-reply`, `validate-booking`, `decide-route`, and the tool allowlists in `process-message.test.ts`), and `scenarios-lib.test.ts` checks that the adversarial scenarios' own patterns pass and fail the replies they should. The red-team doc also lists the dev-harness checks for the alert cooldown, an emergency after another alert, and the booking limit.

## What CI runs

| CI job | What it runs |
|---|---|
| `quality` | `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `test` (every Vitest suite above), `build:workflows -- --check`, `check`, and ShellCheck on every tracked `*.sh`. |
| `security` | gitleaks over the full history, then `pnpm install --frozen-lockfile` and `pnpm audit --audit-level=high`. |
| `actions` | actionlint and zizmor (installed from hash-pinned requirements) against the workflow files. |
| `n8n` | `node scripts/init-env.ts`, `cp config/config.example.json config/config.json`, `docker compose up -d --wait postgres n8n`, `pnpm run setup`, `node scripts/check-db.ts`, `node scripts/check-dev-response.ts`, the container logs on failure, and `docker compose down -v` always. Its `timeout-minutes` is 20. |
| `codeql` | `javascript-typescript`, ignoring the generated `docs/diagrams/` pages, on pull requests, pushes to `main`, and weekly on Mondays. It runs only once the repository is public. |

CI doesn't run the scenario suites (they need TypeSafe, Anthropic, and Google credentials), the queue-mode stack (`compose.queue.yaml`), the `tunnel` profile, or any harness target whose workflow needs a third-party credential.

## Deferred live checks

These need real accounts or services, so they're run by hand and recorded in the pull request that changes them:

- the scenario and red-team suites above, against real TypeSafe, Anthropic, and Google credentials;
- the checks in the README's [Pending live checks](../README.md#pending-live-checks): the `tunnel` profile and its path allowlist, rate limit, and request-size cap; queue mode; and a Gmail credential limited to `gmail.send`;
- the open questions in the red-team doc's [Questions only a live run can answer](red-team.md#questions-only-a-live-run-can-answer), such as whether n8n's WhatsApp Trigger drops an unsigned POST.
