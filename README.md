# Cumbident WhatsApp AI Receptionist

**Demo**

An n8n WhatsApp assistant that answers a dental studio's questions, books appointments in Google Calendar, and hands patients to staff when needed.

## Status

In progress: local runtime, toolchain, workflow tooling/CI, the business content and system prompt, the platform workflows every other workflow relies on, the business tools `check-availability`, `upsert-patient`, and `book-appointment`, Jev-based message triage, and `process-message`, the core every patient message runs through.

### What works now

- A strict TypeScript toolchain: `typecheck`, `lint`, and `test` scripts.
- The local runtime: Postgres and n8n in Docker Compose, with separate, least-privilege database roles for n8n and the application.
- An optional `tunnel` profile that exposes n8n through ngrok, restricted to forwarding webhook traffic only.
- Workflow tooling: a manifest of fixed workflow and credential IDs, hygiene checks that reject pinned data, literal secrets, and hand-written Code nodes, and a Code-node build that compiles `src/nodes/*.ts` into Code-node JavaScript with esbuild — hardened so a node's exports survive n8n's Code-node sandbox, which runs generated code with `Object.defineProperty` disabled.
- Scripts to set up credentials and import, export, and publish workflows against the local n8n instance, plus a dev-harness client for calling a sub-workflow directly during offline testing.
- A GitHub Actions pipeline: the full quality gate, ShellCheck, gitleaks, `npm audit`, actionlint, zizmor, and a CodeQL scan (turns on once the repo is public).
- Business content the workflows load at runtime: `business/business.json` (the facts — address, hours, prices, payment methods, fixed replies), `business/knowledge-base.md` (FAQ prose), and `prompts/system-prompt.md` (the assistant's system prompt template, with `<<BUSINESS>>`, `<<KNOWLEDGE_BASE>>`, `<<NOW>>`, and `<<TRIAGE_NOTES>>` placeholders), all checked by `tests/content.test.ts`.
- The four platform workflows every other workflow depends on: `load-context` (reads the business content above into one item), `error-handler` (emails the team when any other workflow fails), `notify-team` (alerts the team by email for a flagged conversation), and the token-protected `dev-harness`, which lets `node scripts/dev-call.ts <target> '<json>'` call any of these directly over HTTP without WhatsApp or the n8n editor.
- `check-availability`: computes open appointment slots from the business's hours, minimum notice, and Google Calendar's busy events (`src/nodes/compute-free-slots.ts`, unit-tested). Before calling Calendar, a "Check date" step re-runs that same logic with no events, so an invalid, past, or closed date is rejected offline without an avoidable API call; only a valid, open date reaches Calendar. A Calendar failure alerts the team through `notify-team` and reports `calendar_unavailable`.
- `upsert-patient`: validates `phone` and `status`, then appends or updates the matching row (by phone) in the Patients Google Sheet. It looks the row up first and merges in the new fields, so a call that only sends `status` doesn't blank out a `name` or `last_appointment` a previous call stored, and an `inquiry` update keeps a stored status rather than downgrading a `booked` or `handed_off` patient; cell values are written raw so `phone` round-trips as the exact string, never a reformatted number. A Sheets failure alerts the team through `notify-team` and reports `sheets_unavailable`. The dev harness also gained `find-patient` (a phone lookup that answers `{ "rows": [] }` for a patient with no row yet) and `cleanup` (deletes one phone prefix's test data from Calendar, Sheets, and Postgres — refusing, before touching anything, a prefix that isn't 8 or more digits — with `null` for any one of its four independent parts that failed).
- `book-appointment`: validates the service, date, time, opening hours, and minimum notice entirely offline (`src/nodes/validate-booking.ts`, unit-tested) before Calendar is ever called, with the same ordered-checks approach as `check-availability`. Only a valid request re-checks the exact `[start, end)` slot in Calendar (Recurring Event Handling "expand", Always Output Data so an empty result doesn't stop the branch); any event already in that window answers `slot_taken` instead of double-booking it. Otherwise it creates the Calendar event, upserts the patient as `booked` with `last_appointment` set to the new start time, and returns the event id, start, end, service, and price. A Calendar failure alerts the team through `notify-team` and reports `calendar_unavailable`.
- `triage-message`: asks TypeSafe's Jev model (`jev-1.14.0`) five yes/no questions about the latest patient message and up to 3 earlier ones — `emergency`, `asks_for_human`, `complaint`, `medical_advice`, `manipulation` — then applies `config.triage.thresholds` to pick one route: `blocked` (manipulation, which overrides everything else), `emergency`, `handoff` (asks a human or complains), or `agent`, plus flags and agent-facing notes (`src/nodes/decide-route.ts`, unit-tested). It fails open: a Jev request that errors, times out, or answers incompletely — any score missing, non-numeric, or outside `[0, 1]` — returns `scores: null`, `route: "agent"`, and `flags.triage_failed: true`, so a TypeSafe outage can never block a reply. `node scripts/run-scenarios.ts --triage` grades a 17-item English/Spanish evaluation set (`tests/scenarios/triage.json`) against the live model and prints a per-language, per-signal accuracy table, once a real TypeSafe credential exists.
- `process-message`: the core every patient message runs through. It records the message in Postgres first, so a repeated `message_id` (Meta redelivering a webhook) answers `duplicate` with no reply and no second agent run. A non-text or whitespace-only message gets a fixed reply; a phone that sends more than `config.limits.max_messages_per_window` text messages in `config.limits.window_minutes` gets one rate-limit notice, then silence. Text is cut to `config.limits.max_text_chars` characters, never mid-character, and triaged with up to 3 earlier messages. `blocked` gets a fixed reply. `emergency` and `handoff` alert the team first (a handoff also marks the patient `handed_off`), and the agent still replies to them, as it does to every other message. The agent is Claude Haiku 5.5 with Postgres chat memory and four tools — `check_availability`, `book_appointment`, `upsert_patient`, `notify_team` — that always take the phone number from the incoming message, never from the model, and its prompt says the team was alerted only when that alert actually sent. The system prompt is filled by `src/nodes/build-system-prompt.ts` and the tool results collected by `src/nodes/collect-tool-calls.ts` (both unit-tested). If the agent fails, `notify-team` sends the team a `tool_failure` alert, and the patient gets the fixed `technical_issue` reply (route `fallback`), or `technical_issue_retry`, which doesn't say the team was notified, when that alert didn't send. It returns `{ reply, route, flags, tool_calls }`.

## Quick start

```bash
cp .env.example .env
cp config/config.example.json config/config.json
npm ci
docker compose up -d --wait
npm test
```

Fill in the generated secrets in `.env` before bringing up the stack (see `.env.example` for what's required).

Once n8n is up, `npm run setup` imports whichever credentials already have their `.env` values filled and publishes the workflows in `workflows/`; a workflow whose trigger needs a credential that isn't filled in yet (Google, WhatsApp) is held back rather than published half-configured. With no Google credentials, try the platform workflows directly:

```bash
node scripts/dev-call.ts load-context '{}'
node scripts/dev-call.ts notify-team '{"reason":"other","phone":"570000000001","summary":"Plan test"}'
node scripts/dev-call.ts check-availability '{"date":"<a Sunday>","phone":"570000000001"}'
node scripts/dev-call.ts check-availability '{"date":"<a weekday>","phone":"570000000001"}'
node scripts/dev-call.ts upsert-patient '{"phone":"570000000001","status":"inquiry"}'
node scripts/dev-call.ts cleanup '{"phone_prefix":"57"}'
node scripts/dev-call.ts cleanup '{"phone_prefix":"5700000000"}'
node scripts/dev-call.ts book-appointment '{"phone":"570000000001","name":"Test Patient","service":"Dental implants","date":"<next Wednesday>","time":"09:30"}'
node scripts/dev-call.ts book-appointment '{"phone":"570000000001","name":"Test Patient","service":"Dental cleaning","date":"<next Wednesday>","time":"09:30"}'
node scripts/dev-call.ts triage-message '{"text":"Can I please talk to a real person?","recent_messages":[]}'
node scripts/dev-call.ts process-message '{"channel":"test","message_id":"t-1","phone":"570000000002","name":"Test","type":"text","text":"How much is a dental cleaning?","received_at":"<now, as ISO 8601>"}'
```

The `notify-team` call answers `{"ok":false,"reason":"email_failed"}` until a real Gmail credential exists, and the second `check-availability` call answers `{"ok":false,"reason":"calendar_unavailable"}` until a real Google Calendar credential exists — those are the expected offline results, not a bug. The Sunday call answers `{"ok":false,"reason":"closed"}` without needing Calendar at all. The `upsert-patient` call answers `{"ok":false,"reason":"sheets_unavailable"}` the same way, until a real Google Sheets credential exists. `cleanup '{"phone_prefix":"57"}'` is refused (`prefix_too_short`) before touching anything; `cleanup '{"phone_prefix":"5700000000"}'` runs its two Postgres deletes for real and answers with their counts, with `null` for the Calendar and Sheets parts until those credentials exist. The first `book-appointment` call answers `{"ok":false,"reason":"invalid_service"}` without touching Calendar; the second, a valid request, answers `{"ok":false,"reason":"calendar_unavailable"}` the same way as `check-availability`, until a real Google Calendar credential exists. The `triage-message` call answers `scores: null`, `route: "agent"`, and `flags.triage_failed: true` until a real TypeSafe credential exists — triage fails open rather than risk blocking a reply. The `process-message` call answers `route: "fallback"` with the fixed `technical_issue_retry` reply until real Anthropic and Gmail credentials exist: triage fails open, the agent can't reach Claude, and the team alert can't send, so the reply doesn't claim the team was notified. Running it again with the same `message_id` answers `{"reply":null,"route":"duplicate","flags":{},"tool_calls":[]}`. See `AGENTS.md` for the full command list.

## License

MIT — see [LICENSE](./LICENSE).
