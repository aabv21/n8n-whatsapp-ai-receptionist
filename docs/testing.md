# Test suites

This page lists every test suite in the repo: its command, what it covers, and how it stays deterministic and clean. It then covers the checks that need the local Docker stack, the dev harness, the scenario and red-team suites that need real credentials, what continuous integration (CI) runs, and the live checks still deferred.

## Unit and workflow tests (Vitest)

**Command:** `pnpm test` (`vitest run`, config `vitest.config.ts`, which includes `tests/**/*.test.ts` and loads `tests/setup.ts` first).

**Code-node sources** (`tests/nodes/`), one file per `src/nodes/` module:

- `build-system-prompt.test.ts` — every placeholder filled, triage notes one per line, text inserted verbatim, the TEAM ALERTED note only after a sent alert, and the language hint: a detected language named as this message's, an undetected one naming the default without claiming the patient wrote in it.
- `check-reply.test.ts` — the reply check: each dose, dosing-interval, and medicine pattern (brands common in Colombia and classes included, whole words only) gets the fixed `medical_advice` reply; an unlisted peso amount or a discount gets `price_check`; listed prices, plain numbers, hours, dates, and the address are kept; one confirmation line per booking made that turn, in the business timezone and the message's language; English fallback for a missing or unsupported language.
- `collect-tool-calls.test.ts` — the agent's intermediate steps become `tool_calls`, with JSON observations parsed.
- `compute-free-slots.test.ts` — `check-availability`'s slot logic: Sunday closed, past and invalid dates, minimum notice, busy and all-day events, Saturday hours, an empty calendar, a day past the booking horizon (`too_far`), the horizon day's slots, and a missing or invalid `max_booking_days_ahead` failing with a fixed message.
- `count-cleanup-outcomes.test.ts` — the dev harness's `cleanup` count, `null` on any failure.
- `decide-route.test.ts` — triage thresholds: fail open on missing or out-of-range scores, `blocked` overriding everything, inclusive thresholds, which alert reason wins, and a missing or invalid threshold failing the run instead of turning its signal off.
- `detect-language.test.ts` — the deterministic language check, including names never deciding the language and every triage fixture and conversation turn resolving to its declared language.
- `locale.test.ts` — `normalizeLocale` and the fallback rules for a missing, supported, or unsupported setting.
- `resolve-language.test.ts` — `Resolve language`: a message that shows its language, a non-text message, an old config without the locale settings, an unsupported `locale.default`, and that `team_locale` never matters here.
- `team-messages.test.ts` — every team label and alert reason in both languages, the alert and failure emails in English and Spanish, a missing or invalid `team_locale` still sending in English with a line saying so, and a missing or invalid `alert_cooldown_minutes` adding its own line after it.
- `validate-booking.test.ts` — every `book-appointment` rejection before any Calendar call (unknown service, missing name, bad time, closed day, outside hours, past, too soon, off the slot grid, past the horizon, at the per-phone limit), an hour or minute past its range never rolled over, a translated service name mapped back to its canonical one, the trimmed phone and name a valid booking returns, and missing booking limits failing with a fixed message.

**Workflow JSON** (`tests/workflows/`), reading the committed files in `workflows/`:

- `book-appointment.test.ts` — no node reads another through item pairing, an invalid request or a missing limit stops before Calendar, the limit counts only this phone's events, the slot recheck queries exactly `[start, end)`, `Call upsert-patient` maps the trimmed phone and name, and a sticky note labels each canvas section above its nodes.
- `check-availability.test.ts` — `Get busy events` is the Google Calendar node expanding recurring events, and both compute steps pass `config.limits.max_booking_days_ahead`, so `too_far` returns before Calendar.
- `dev-harness.test.ts` — a sticky note per section above its nodes, the cleanup branch reading the request only through `.first()`, the cleanup Calendar search spanning the booking horizon plus a day, and the cleanup note naming each outcome Aggregate's three inputs.
- `error-handler.test.ts` — the failure email comes from the generated `Compose error email`, and writes a Spanish email inside a sandbox that freezes `Object.defineProperty`.
- `execution-data.test.ts` — every workflow sets `saveManualExecutions: false`.
- `injection-guards.test.ts` — every Gmail node sends plain text with no sender name, and every Sheets write stores values raw.
- `load-context.test.ts` — `load-context` names no error workflow, `error-handler` calls nothing that could call it back, every read stays on the typeVersion that fails loudly on a missing file and always passes on an item, and one Merge combines the four.
- `notify-team.test.ts` — the cooldown wiring and query, the emergency rule, a sent alert recorded with its reason, a missing or invalid `alert_cooldown_minutes` sending the alert without the cooldown, and the generated `Compose alert` writing a Spanish alert, and the cooldown note, in the frozen sandbox.
- `process-message.test.ts` — each tool takes the phone from the trigger and lets the model fill only its allowlisted fields, the AI Agent never retries, the chat model's settings, one value per Postgres parameter, the handoff mark, the TEAM ALERTED rule, every reply passing `Check reply`, `Resolve language` right after the duplicate check, the three side calls continuing on error so a failed alert still gets the patient a reply, a sticky note per canvas section, and the generated `Check reply` and `Resolve language` nodes running in the frozen sandbox.
- `retention-cleanup.test.ts` — both deletes reachable only through the `retention_days` guard, in order, with Always Output Data, and the guard's error naming the bad setting.
- `triage-message.test.ts` — `Score message with Jev`'s 2 tries 1000 ms apart, its `config.triage.timeout_ms` timeout, and its error output failing open.
- `upsert-patient.test.ts` — evaluates `Merge patient fields`' expression: a blank or whitespace-only field keeps the stored value, a non-blank one overwrites it, and `last_contact` is today in `business.timezone`.
- `whatsapp-entry.test.ts` — one `process-message` run per trigger item, the send's recipient and phone number id, its 3 tries 2000 ms apart, and `Mark replied` only after, and only from, a successful send.

**Tooling, content, and repo rules** (`tests/*.test.ts`):

- `tooling.test.ts` — the hygiene checker against `tests/fixtures/workflows/` (`clean.json`, plus one defect per other fixture), the Code-node build and its frozen-`defineProperty` hardening, `normalizeWorkflow`, the credential manifest and import plan (the Gmail send-only scope, the runtime and owner database roles, existing Google credentials skipped unless forced, credentials only over stdin), which trigger credentials hold back publishing, and `restartProblem` naming an unset `N8N_URL` instead of an unhealthy n8n.
- `export-workflows.test.ts` — `exportWorkflows` with a fake `docker compose`: each manifest workflow written normalized, unknown ids skipped, a brand-new instance's `No workflows found` exporting nothing, and any other failure rethrown.
- `check-db.test.ts` — `scripts/check-db.ts`'s predicates (`isDenied`, `diffGrants`, `roleProblems`), its psql quoting, and one probe per Postgres statement in `workflows/`, so a new query can't skip the check.
- `check-dev-response.test.ts` — the two exact responses `scripts/check-dev-response.ts` accepts.
- `db-migrate.test.ts` — migration ordering and naming, pending-file choice, `\getenv` extraction, the transaction-control and role-name-clash guards, the advisory lock, the `schema_migrations` record, and keeping passwords out of the server log and argument lists.
- `init-env.test.ts` — `scripts/init-env.ts`'s generated secrets, its atomic 0600 `.env` write, the `.n8n-import/` directory, and that `.env.tmp` is gitignored.
- `lib-runtime.test.ts` — `execFileWithInput`'s stdin handling, the webhook-readiness poll behind `pnpm run setup`, and `isEnoent` and `isExecError` defined once, in `scripts/lib/errors.ts`.
- `content.test.ts` — the business facts, the knowledge base, the system prompt's placeholders and rules, a Tool errors rule for every reason a tool can return, argument errors sending the agent back to fix its own call, and every fixed reply present in English and Spanish.
- `runtime.test.ts` — `compose.yaml` and `.env.example` agree, images are pinned, n8n never sees the Postgres superuser, the tunnel policy and payload cap, n8n's 30 s stop grace period, `config/config.example.json`'s values, and an n8n patch named only in a dated "checked against" note.
- `readme.test.ts` — the README's section order, the five-command quick start, a Test scenarios row per conversation, the Patients columns and every config key under Configuration, and the 26 numbered live checks.
- `scenarios-lib.test.ts` — the scenario grader (`triageAccuracy`, `checkTurn`, `nextWeekday`) and the conversation fixtures' ids, phones, and patterns, including the adversarial ones.
- `supply-chain.test.ts` — pnpm's effective supply-chain config, the exact pnpm 11 pin, no `package-lock.json` or `npm` instructions, digest-pinned images, `no-new-privileges` and dropped capabilities, and hash-pinned zizmor.
- `hygiene.test.ts` — no tracked file points at a plan task, a brief, a ruling, or a review finding instead of stating its reason.

Three helpers in `tests/helpers/` aren't test files: `run-generated.ts` runs a generated Code node's `jsCode` the way n8n's sandbox does, `run-expression.ts` evaluates one `={{ … }}` field expression with `$()`, `$json`, and `$now` in scope, and `sticky-sections.ts` reads each sticky note's heading and x-span. `tests/fixtures/nodes/double-value.ts` is the one-line Code-node source the build tests compile.

**Staying deterministic and clean:**

- No test opens a network connection or needs Docker. The webhook-readiness poll gets a fake `fetch`, and the one test that would call `docker compose` (`existingCredentialIds` in `tooling.test.ts`) mocks `scripts/lib/runtime.ts`'s `compose`.
- Code-node sources never read the clock: each takes `now` as input, so every test passes a fixed instant. `tests/setup.ts` provides the ambient `DateTime` global the sandbox exposes, from the same Luxon the sources are typed against.
- Generated nodes are tested twice: as TypeScript, and as the committed `jsCode`, inside a sandbox that freezes `Object.defineProperty` like n8n's Task Runner.
- Only `init-env.test.ts`, `tooling.test.ts`, and `export-workflows.test.ts` write files, each to a fresh `mkdtempSync` directory under the OS temp dir, never the repo. A few tests run read-only commands: `git ls-files`, `git check-ignore`, and `pnpm config list --json`; `lib-runtime.test.ts` spawns plain local commands to prove its stdin handling.
- No test reads `.env` or `config/config.json`; they read the committed `.env.example` and `config/config.example.json` instead.

## Build and hygiene commands

CI runs these directly, not through a test file:

- `pnpm run typecheck` and `pnpm run lint` — `tsc --noEmit` and ESLint (with `eslint-plugin-security`) over the repo.
- `pnpm run build:workflows -- --check` — fails if a Code node's committed `jsCode` doesn't match a fresh build of its `src/nodes/*.ts` source.
- `pnpm run check` — the hygiene checker against `workflows/` itself: pinned data, literal emails, phones, long ids, and secrets, unknown credential ids, undocumented or hand-written Code nodes, required settings, retries on external calls, Postgres queries built from expressions, and `$n` placeholders inside SQL comments.

## Stack checks (Docker)

**Commands:** `docker compose up -d --wait postgres n8n`, `pnpm run setup`, then `node scripts/check-db.ts` and `node scripts/check-dev-response.ts`. Tear down with `docker compose down`; add `-v` only for a disposable stack.

- `node scripts/check-db.ts` — runs psql inside the `postgres` container. As `app_runtime`, DDL, `TRUNCATE`, connecting to `n8n`, and `SET ROLE` to the owner are all denied with the exact expected error; its privileges equal the grant list; every workflow's SQL runs under it inside a rolled-back transaction; and `schema_migrations` records every migration. [docs/database.md](database.md#proving-it-check-db) has the details.
- `node scripts/check-dev-response.ts` — two dev-harness calls with exact expected answers: `retention` (a plain Postgres path) and `check-availability` with a past date (rejected by the generated `Check date` node before any Calendar call). Neither needs a third-party credential.

**Staying deterministic and clean:** both scripts need only the generated `.env` and the example config. `check-db` rolls back every probe, and `check-dev-response` uses a fixed past date and the `retention` target, which deletes only expired rows.

## The dev harness

`node scripts/dev-call.ts <target> '<json>'` calls `POST {N8N_URL}/webhook/dev` with the `X-Dev-Token` header, to run a sub-workflow without WhatsApp: for example, `node scripts/dev-call.ts load-context '{}'` or `node scripts/dev-call.ts notify-team '{"reason":"other","phone":"570000000001"}'`. A request without the header answers `403` (checked against n8n `2.45.7` on 2026-11-11), and an unknown target answers `404 {"error":"unknown_target"}`.

- **`process-message`** takes the full contract input: `channel`, `message_id`, `phone`, `name`, `type`, `text`, and `received_at`. Use `channel: "test"`, so its chat memory is keyed `test:<phone>`, which `cleanup` also deletes, and a fresh `message_id` per call, since a repeated one answers `duplicate`.
- **`find-patient '{"phone":...}'`** exists only in the harness. It looks a Patients row up by exact phone and answers `{ "rows": [...] }`.
- **`cleanup '{"phone_prefix":...}'`** exists only in the harness. It deletes a prefix's test data from Calendar, Sheets, and Postgres, and the scenario runner calls it before and after a run. It refuses any prefix that isn't 8 or more digits with `{"ok":false,"reason":"prefix_too_short"}` before touching anything, and reports `null` for any of its four parts that failed.
- **`retention '{}'`** exists only in the harness. It runs `retention-cleanup` through its Execute Workflow Trigger. Unlike every other target, it needs no third-party credential, so it always runs for real and answers `{"success":true}`, the Postgres node's own result for a `DELETE` with nothing left to return.

## Scenario suites

These call the real models through the dev harness, so they need `N8N_URL`, `DEV_HARNESS_TOKEN`, and real credentials. CI doesn't run them.

- `pnpm run scenarios -- --triage` — sends each of the 17 English and Spanish messages in `tests/scenarios/triage.json` to `triage-message` and prints a `| lang | signal | correct/total |` table. It never fails the run, and without a TypeSafe credential every score is `null` and counts as wrong.
- `pnpm run scenarios` — the triage table, then the 20 multi-turn conversations in `tests/scenarios/conversations.json` through `process-message`, each turn checked against its route, tools, reply text, and tool input and output. It exits 1 only when a conversation is `FAIL`, never for the triage table or a `SKIP`; a scenario that needs tomorrow open prints `SKIP` on a Sunday in America/Bogota. A harness call that throws, such as `find-patient` without a live Sheets credential, reports as that scenario's `FAIL` instead of aborting the batch.
- `pnpm run scenarios -- --only <id>` — one conversation, such as `hours`.
- `pnpm run scenarios -- --tool-failure` — one more scenario that points `config.google.calendar_id` at an invalid id to exercise `calendar_unavailable` and its team alert. It backs up `config/config.json` first, restores it afterward even if the run fails, and never prints its contents.

**Staying deterministic and clean:** relative dates such as `{{next_thursday}}` resolve from the run's own date in America/Bogota. Every scenario uses its own `5700000000` test phone, and the harness's `cleanup` target deletes that prefix's Calendar events, sheet rows, and Postgres rows before and after the batch. Without real credentials, every conversation reports `FAIL` with route `fallback`; that's the expected offline result, not a regression.

## Red-team suite

[docs/red-team.md](red-team.md) maps each adversarial input to the guard that handles it. Nine of the conversations above are its live checks: `instruction-override`, `prompt-extraction`, `other-patient-data`, `booking-limit`, `fake-discount`, `dose-request`, `classifier-injection`, `context-poisoning`, and `cancellation`. Their deterministic guards are already covered by the Vitest suites above (`check-reply`, `validate-booking`, `decide-route`, and the tool allowlists in `process-message.test.ts`), and `scenarios-lib.test.ts` checks that the adversarial scenarios' own patterns pass and fail the replies they should. The red-team doc also lists the dev-harness checks for the alert cooldown, an emergency after another alert, and the booking limit.

## What CI runs

| CI job | What it runs |
|---|---|
| `quality` | `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `test` (every Vitest suite above), `build:workflows -- --check`, `check`, and ShellCheck on every tracked `*.sh`. |
| `security` | gitleaks over the full history, then `pnpm install --frozen-lockfile` and `pnpm audit --audit-level=high`. |
| `actions` | actionlint and zizmor (installed from hash-pinned requirements) against the workflow files. |
| `n8n` | `node scripts/init-env.ts`, `cp config/config.example.json config/config.json`, `docker compose up -d --wait postgres n8n`, `pnpm run setup`, `node scripts/check-db.ts`, `node scripts/check-dev-response.ts`, the container logs on failure, and `docker compose down -v` always. It takes about 2.5 minutes, inside a `timeout-minutes` of 20. |
| `codeql` | `javascript-typescript` and `actions`, ignoring the generated `docs/diagrams/` pages, on pull requests, pushes to `main`, and weekly on Mondays. It runs only once the repository is public. |

CI doesn't run the scenario suites (they need TypeSafe, Anthropic, and Google credentials), the queue-mode stack (`compose.queue.yaml`, which needs no credential but proves nothing about plain-node and Code-node execution that `check-dev-response.ts` doesn't), the `tunnel` profile, or any harness target whose workflow needs a third-party credential.

## Deferred live checks

The README's [Pending live checks](../README.md#pending-live-checks) is the single list of what needs real accounts or services: 26 checks in order, each with its exact command (or the manual action where none exists) and expected result, from the Jev model ID to the measured cost per message. That list covers the scenario and red-team suites, the tunnel, queue mode, and the red-team doc's [open questions](red-team.md#questions-only-a-live-run-can-answer). Record each result in the pull request that runs it.
