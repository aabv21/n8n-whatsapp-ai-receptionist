# How the Cumbident WhatsApp receptionist works

This page follows a patient’s WhatsApp message from webhook to reply, then covers failures, scaling, security, and the reasons behind each design choice.

![System architecture: WhatsApp reaches n8n through a one-path ngrok tunnel, and n8n’s workflows call Postgres, Google, Anthropic, and TypeSafe](diagrams/architecture.svg)

The diagram tool [archify](https://github.com/tt-a1i/archify) generates both diagrams on this page from their sources in `docs/diagrams/*.json`, and `AGENTS.md` shows how to regenerate them. For the interactive versions, with search, focus, and both color themes, open `docs/diagrams/architecture.html` and `docs/diagrams/message-sequence.html` in a browser.

## What the system does and where it runs

Cumbident is a fictional dental studio in Barranquilla, Colombia, and patients write to its WhatsApp number. The assistant does four jobs:

- answers questions from the studio’s facts and knowledge base
- offers and books appointments in Google Calendar
- keeps a patient list in a Google Sheet
- emails the team when a person needs to step in

Everything runs in one Docker Compose project, `cumbident-whatsapp`:

- **n8n 2.45.6**: runs every workflow, and Compose publishes its port on `127.0.0.1:5678` only, so nothing outside the host reaches it directly
- **Postgres 17**: holds two databases, `n8n` for n8n’s own data and `app` for messages and chat memory
- **ngrok** (Compose profile `tunnel`): the only public entry point, and it forwards one path
- **Redis and `n8n-worker`** (optional, `compose.queue.yaml`): queue mode, covered under scaling

The external services are Meta’s WhatsApp Cloud API, Anthropic (Claude Haiku 5.5), TypeSafe (its Jev model), and Google Calendar, Sheets, and Gmail.

## What each component does

Eleven n8n workflows split the work. Each has a fixed ID in `scripts/manifest.ts`, and every one except `error-handler` sends its failures to `error-handler`:

| Workflow | Started by | What it does |
|---|---|---|
| `whatsapp-entry` | Meta’s webhook, through the WhatsApp Trigger | Checks the webhook signature, skips anything that isn’t a message, normalizes `messages[0]`, runs `process-message` once per change, sends the reply, and sets `replied_at` |
| `process-message` | `whatsapp-entry` or the dev harness | Records and dedupes the message, rate-limits, triages, routes, alerts, runs the AI Agent, saves the route, and returns `{ reply, route, flags, tool_calls }` |
| `triage-message` | `process-message` | Asks Jev (`jev-1.14.0`, set in `config.triage.model`) five yes/no questions and turns the scores into a route, flags, and notes |
| `check-availability` | The AI Agent | Offers up to 3 free 45-minute slots on one day, from the opening hours and Calendar’s busy events |
| `book-appointment` | The AI Agent | Validates the request, re-checks the slot, creates the Calendar event, and marks the patient `booked` |
| `upsert-patient` | The AI Agent, `book-appointment`, `process-message` | Merges and writes the patient’s row in the Patients sheet |
| `notify-team` | The AI Agent, `process-message`, and the three tools above | Emails the team a plain-text alert and returns `{ ok }` |
| `load-context` | Every workflow that needs business data | Reads the four mounted files into one item |
| `error-handler` | Any other workflow’s failure | Emails the team the failed workflow, node, error, and execution link |
| `retention-cleanup` | A schedule, daily at 03:00 Bogota time | Deletes old chat memory, then old messages |
| `dev-harness` | `POST /webhook/dev` with `X-Dev-Token` | Runs a named target (any sub-workflow, plus `find-patient`, `cleanup`, and `raise-error`) for tests |

The AI Agent is a node inside `process-message`. It uses the Anthropic Chat Model node with Claude Haiku 5.5, a Postgres chat memory of the last 10 exchanges per phone, and four tools: `check_availability`, `book_appointment`, `upsert_patient`, and `notify_team`. `npm run build:workflows` generates every Code node from a pure function in `src/nodes/*.ts`.

The business content lives in four files that n8n reads from read-only mounts: `business/business.json` (facts, prices, fixed replies), `business/knowledge-base.md`, `prompts/system-prompt.md`, and `config/config.json` (Google IDs, team email, triage thresholds, limits).

## How a message becomes a reply

A text message goes through nine steps from the WhatsApp Trigger to the reply, and the numbers match the bands in this sequence diagram:

![Message lifecycle: signature check, normalize, record and dedupe, rate limit, triage, route, agent with tool calls, reply, and mark replied](diagrams/message-sequence.svg)

1. **Signature check**: Meta posts the webhook to the tunnel, which forwards only the trigger’s path. The trigger computes a hash-based message authentication code (HMAC-SHA256) of the raw body with the app secret. It compares the result with `X-Hub-Signature-256`, and a mismatch starts nothing; otherwise n8n starts the execution and then answers 200.
2. **Normalize**: One webhook call from Meta can hold more than one change, each with its own `messages` array. `whatsapp-entry` drops changes without a message, plus reactions and system messages. For the rest, it maps `messages[0]` to the `process-message` input, with `type: other` and empty text for anything but text, and runs `process-message` once per change.
3. **Record and dedupe**: `process-message` trims the text, cuts it to 2,000 characters, and inserts the message with `ON CONFLICT (message_id) DO NOTHING`. Zero inserted rows means Meta already delivered it, so the result is `duplicate` with no reply.
4. **Rate limit**: A non-text or whitespace-only message gets the fixed `non_text` reply. For text, Postgres counts the phone’s text messages in a sliding 10-minute window. The message that brings the count to 21 gets the `rate_limited` notice; later messages get no reply until the window holds 20 or fewer again.
5. **Triage**: `triage-message` sends the text and up to 3 earlier messages to Jev. The thresholds pick one route: manipulation means `blocked`, an emergency means `emergency`, a request for a person or a complaint means `handoff`, and anything else means `agent`. Missing or invalid scores fail open: the route is `agent`, with `triage_failed: true`.
6. **Route**: `blocked` gets a fixed reply and stops. `emergency` alerts the team, and `handoff` marks the patient `handed_off` and then alerts; both continue to the agent, as `agent` does.
7. **Agent with tool calls**: The system prompt gets the business facts, the knowledge base, the current Bogota time, and the triage notes. A TEAM ALERTED note joins them only when the alert sent. The agent runs up to 6 iterations, and its tools take the phone from the workflow input. If it fails or returns no text, the team gets a `tool_failure` alert, and the patient gets a fixed apology with route `fallback`.
8. **Reply**: `process-message` saves the route and returns `{ reply, route, flags, tool_calls }`. `whatsapp-entry` sends any non-empty reply through the WhatsApp node, with 3 tries 2000 ms apart.
9. **Mark replied**: Only a send that succeeds sets `replied_at`, which records that Meta accepted the message, not that the phone received it.

The limits in steps 3 and 4 are the defaults in `config/config.example.json`.

## What gets stored where

Postgres keeps the conversation state, Google keeps the records staff work with, and each store has its own lifetime:

| Store | What it holds | How long |
|---|---|---|
| Table `inbound_messages` in database `app` | One row per inbound message: `message_id` (primary key), `channel` (`whatsapp` or `test`), `phone`, `body` (`NULL` for non-text), `triage` (JSON), `route`, `received_at`, `replied_at`; indexed on `(phone, received_at DESC)` | `retention_days` (30 by default), then `retention-cleanup` deletes it |
| Table `n8n_chat_histories` in database `app` | The agent’s memory, one row per message; `session_id` is the phone, or `test:` plus the phone on the test channel | Until its phone has no message inside `retention_days` |
| Postgres database `n8n` | n8n’s workflows, its credentials (encrypted with `N8N_ENCRYPTION_KEY`), and its executions | Executions: 168 hours |
| Google Sheet, `Patients` tab | One row per phone: `last_contact`, `name`, `phone`, `service_of_interest`, `status` (`inquiry`, `booked`, or `handed_off`), `last_appointment`; written raw, so the phone stays text | Until staff delete it |
| Google Calendar | One event per booking, titled like `Appointment: Dental cleaning - Test Patient`, with the phone in the description | Until staff delete it |

## What happens when something fails

The table lists what each failure does to the patient, how you find out, and how to recover. Unless a row says otherwise, an external call retries 3 times, 1000 ms apart, before it counts as failed.

| Failure | Behavior | Detection | Recovery |
|---|---|---|---|
| Meta delivers a message twice | The insert finds the `message_id` and adds no row, so the result is `duplicate` with `reply: null`: no second triage, agent run, or reply. One statement inserts and counts, so concurrent copies can’t both pass. | The second `process-message` run ends at `Return duplicate`. | None needed. |
| Jev is down or answers incompletely | Jev gets 2 tries with a 3000 ms timeout each. After that, or when any score is missing or outside 0 to 1, triage fails open: route `agent`, `triage_failed: true`, and no notes. | `inbound_messages.triage` has `"scores": null`. | Automatic. With no notes, the prompt tells the agent to call `notify_team` itself for an emergency, a complaint, or a request for a person. |
| Anthropic is down | The model call retries transient errors up to 6 times, but not request errors like 400 or 401, and then the agent fails. `notify-team` sends a `tool_failure` alert, and the patient gets `technical_issue` if it sent or `technical_issue_retry` if not. | The alert email; rows with `route = 'fallback'`. | The patient writes again later; the team follows up from the alert. |
| Google Calendar is down | `check-availability` or `book-appointment` alerts the team and returns `calendar_unavailable`, with `team_notified: true` only when the alert sent. The prompt lets the agent promise a follow-up only in that case, and `book-appointment` creates no event. | The alert email. | The patient tries again, or staff call back. |
| Google Sheets is down | `upsert-patient` alerts the team and returns `sheets_unavailable`, with `team_notified` set the same way. A booking still succeeds, because the Calendar event is the booking. | The alert email. | Staff update the row from the alert, and the next upsert for that phone merges again. |
| Gmail is down | Every alert returns `email_failed`, so no result has `team_notified`, no prompt note claims an alert, and an agent failure gets `technical_issue_retry`. The email from `error-handler` fails too. | Only n8n’s executions list: `error-handler` runs fail, and `notify-team` runs end at `Return failure`. | Reconnect the Gmail credential, then review the outage’s executions within 168 hours. |
| A lookup returns nothing | Lookups aggregate in SQL (`count(*)`, `coalesce(array_agg(…), '{}')`) or set Always Output Data, so a first message, an empty calendar day, or a phone with no sheet row still continues. | `tests/nodes/compute-free-slots.test.ts` pins the empty-calendar case. | None needed. |
| Two bookings for the same slot | `book-appointment` re-reads Calendar for exactly `[start, end)` before it creates the event, so a slot that someone took after `check-availability` offered it returns `slot_taken`. Nothing locks the slot between that read and the create, so two requests for one slot at the same moment can both pass and both create events. | Two overlapping events in the calendar. | Staff move one patient. Upgrade: reserve the slot first, with a unique row per slot start in Postgres. |
| n8n restarts mid-execution | n8n answered Meta 200 when the execution started, so Meta won’t redeliver. A run still going at shutdown isn’t resumed: at the next start, n8n marks it crashed. | The crashed execution. When its event log shows a node that started and never finished, n8n also runs `error-handler`. | The patient writes again. While n8n is down, Meta gets no 200 and redelivers for up to 7 days ([Meta webhook retries](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks)), and the `message_id` dedupe turns repeats into `duplicate`. |
| Postgres is down | If the `app` database fails mid-run, `Record inbound message` fails after its 3 tries, the run fails into `error-handler`, and the patient gets no reply. If the whole server is down, n8n can’t create the execution either, because its own database is on that server. Meta then gets no 200 and redelivers later. | The `error-handler` email, if Gmail works; `docker compose ps` shows `postgres` unhealthy. | Restore Postgres, and redelivered messages run normally. Upgrade, noted in `whatsapp-entry`: an error output that alerts and sends `technical_issue_retry`. |
| One patient sends a burst | Only text counts toward the limit: 20 messages in a sliding 10-minute window. The message that brings the count to 21 gets one `rate_limited` notice; later ones get no reply, and make no triage or agent call, until the window holds 20 or fewer again. Each non-text message gets the fixed `non_text` reply, with no paid call. A Meta batch runs `process-message` once per change. | Rows with `route = 'rate_limited'`. | Automatic once the window holds 20 or fewer. |
| A reaction or system message arrives | `whatsapp-entry` stops it: no reply, no row, and no rate-limit count. | None needed. | None needed. |
| `retention_days` is missing or invalid | `retention-cleanup` refuses to delete unless the value is an integer of 1 or more, and fails into `error-handler` with “config.limits.retention_days must be an integer of 1 or more”. | The `error-handler` email. | Fix `config/config.json`; the next run prunes. |

On shutdown, n8n waits up to 30s for running executions, but Compose kills the container after its default 10s grace period ([Compose reference](https://docs.docker.com/reference/compose-file/services/#stop_grace_period)), because `compose.yaml` doesn’t set `stop_grace_period`. Setting `stop_grace_period: 30s` on the `n8n` service would give running executions n8n’s full 30s.

## Known limits of the current design

The current design accepts these gaps:

- After an empty agent reply that followed tool calls, the fallback result has `tool_calls: []`. The team alert names the execution ID, and that execution keeps the steps.
- Tool calls per message have no cap. `maxIterations: 6` bounds the agent’s turns, not the calls within one turn, and the per-phone rate limit bounds the total.
- The handoff alert waits for the Sheets upsert, including its retries.
- `whatsapp-entry` reads only `messages[0]` of each change, so a change with more than one message loses the rest. The upgrade is a Split Out node on `messages`.
- `replied_at` means Meta accepted the send, not that the phone received it, because the trigger takes no status callbacks.
- `upsert-patient` reads the row, merges, and then writes, so two upserts for one phone at the same moment can lose one update.
- `Create calendar event` retries without a client-supplied event ID, so a create that succeeded but returned an error can leave a second event.

## Scaling limits and what to change

The default stack is one n8n process and one Postgres server. These are the limits it meets first, and what to change:

- **One n8n process**: In regular mode, one process receives webhooks and runs every execution. Executions run concurrently, because `compose.yaml` sets no production concurrency limit. Waiting on Anthropic doesn’t block other runs, so the ceiling is CPU and memory, which webhook intake and the editor share with every execution.
- **Queue mode**: `compose.queue.yaml` adds Redis and `n8n-worker` containers. The main process then only receives webhooks and queues them, each worker runs up to 10 jobs at once by default, and `--scale n8n-worker=N` adds workers. Switch when the main process runs short of CPU or memory, or when intake must stay responsive under load. The override gives Redis no named volume, so a `down` or a crash can lose queued jobs.
- **WhatsApp Cloud API**: A business number can send up to 80 messages per second by default ([Meta throughput and pair rate limits](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)). To one user, it can send one message every 6s, and a burst of up to 45 borrows from later quota. The per-phone limit of 20 text messages per 10 minutes keeps text replies to one patient below that rate. Non-text messages each get a reply, though, so a flood of them can exceed it.
- **Anthropic**: Anthropic sets limits per organization and model class, in requests, input tokens, and output tokens per minute, and raises them with the usage tier. At the Start tier, Claude Haiku 5.5 allows 4,000 requests per minute ([Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)). Each message makes one request per agent iteration, up to 6. Past a limit the API answers 429, and once the client’s retries run out the message ends like any other agent failure.
- **TypeSafe**: TypeSafe publishes no rate-limit figures; it answers 429 or 529 and asks clients to back off exponentially ([TypeSafe request rules and errors](https://docs.typesafe.ai/api/errors)). Triage makes one request per text message, plus one retry, and a failure only skips triage: the message still reaches the agent.
- **Google Sheets**: The API allows 60 write requests per minute per user per project, and 300 per project ([Sheets API limits](https://developers.google.com/workspace/sheets/api/limits)). Every write uses the one Google account behind the credential, so the whole clinic shares those 60. Each `upsert-patient` call also reads before it writes. The upgrade is a `patients` table in Postgres as the record, with the sheet as an export for staff.
- **Postgres**: The `(phone, received_at)` index serves the per-message count and lookup. The daily retention delete filters on `received_at` alone, which no index covers, so add one as the table grows.

## Security and data handling

From outside the host, only the trigger’s path reaches n8n, and only signed requests start a run. Inside, the model never picks whose data a tool touches. Postgres keeps personal data for `retention_days`; the Sheet and Calendar keep theirs until staff delete them. Each control in detail:

- **Webhook signature**: In n8n 2.45.6’s `WhatsAppTrigger.node.js`, the trigger verifies every request except a GET with `hub.challenge`. It computes HMAC-SHA256 of the raw body with the app secret (`META_APP_SECRET`) and compares it with `X-Hub-Signature-256`. A mismatch starts no execution, and n8n still answers 200 `{"message":"Webhook call received"}`.
- **Signature caveats**: Both come from upstream. The comparison isn’t constant-time, and Meta signs no timestamp, so someone who captures a request can replay it. The `message_id` dedupe answers a replay with `duplicate` only within `retention_days`; after that, retention has deleted the original row.
- **Verify token**: Meta’s subscription check uses the trigger node’s `id` as the verify token, and the committed workflow JSON makes that ID public. Someone who knows it can only make n8n echo `hub.challenge`, because creating a subscription needs the app’s credentials.
- **Tunnel**: The ngrok traffic policy first returns 404 for any path containing `%`, `\`, `//`, `/./`, or `/../`. It then forwards only `^/webhook/a0000000-aaaa-4bbb-8ccc-000000000001/webhook$`, the trigger’s path, matched on `req.url.raw_path`. That variable excludes the query string ([ngrok request variables](https://ngrok.com/docs/traffic-policy/variables/req/)), so Meta’s verification GET, with its `hub.*` query parameters, still matches.
- **Dev harness**: `POST /webhook/dev` needs the `X-Dev-Token` header and answers 403 without it. Its path never matches the tunnel allowlist, so only the host can reach it. Unpublish it in production.
- **The model never picks the phone**: Every tool maps `phone` from the workflow’s own trigger, and each tool node maps or removes the inputs the model shouldn’t fill; `tests/workflows/process-message.test.ts` pins the phone mapping. Messages that Jev scores as manipulation get the fixed `blocked` reply and never reach the agent.
- **Plain-text email and parameterized SQL**: Team emails are plain text, so patient text can’t inject markup into a staff inbox. Every query passes values as `$n` Query Parameters, and `npm run check` rejects a query built from an expression.
- **Database roles**: Role `n8n` owns database `n8n` and role `app` owns `app`, with `REVOKE ALL … FROM PUBLIC` on both, so neither role can connect to the other’s database. The Postgres superuser only bootstraps them and never reaches the n8n container.
- **Secrets**: Secrets live only in `.env`, which git ignores, and in n8n credentials, which `N8N_ENCRYPTION_KEY` encrypts. Git ignores `config/config.json` too, and continuous integration (CI) runs gitleaks over the full history.
- **Personal data retention**: `retention-cleanup` runs daily at 03:00 Bogota time. It deletes chat memory whose phone has no message inside `retention_days`, then older messages, and it refuses any `retention_days` that isn’t an integer of 1 or more. n8n prunes its own executions after 168 hours. The trigger takes no status callbacks, so no execution stores a phone only for a delivery receipt.
- **Data outside Postgres**: Retention covers Postgres only. The Patients sheet and Calendar events keep names and phones until staff delete them.
- **File access**: Workflow file nodes can read only `/files` (`N8N_RESTRICT_FILE_ACCESS_TO`), where Compose mounts the business, prompt, and config directories read-only.

## Design decisions and their trade-offs

Each decision names the option it chose, the one it passed over, and why:

- **Claude Haiku 5.5 at `effort: low`, over a larger model or more thinking**: The assistant answers from a short prompt with four tools, so the default is the smallest model at the lowest effort. The node runs `claude-haiku-5-5` with adaptive thinking, `effort: low`, and `maxTokensToSample: 1024`. When a scenario fails, step up in this order: fix the prompt, then `effort: medium`, then Claude Sonnet 5.5 (`claude-sonnet-5-5`). The conversation scenarios (`npm run scenarios`) decide each step.
- **Adaptive thinking with no sampling parameters, over setting a temperature**: In n8n 2.45.6, the Anthropic Chat Model node (typeVersion 1.6) sends `thinking: {type: "adaptive"}`, `output_config.effort`, and `max_tokens` in adaptive mode. For `claude-haiku-5-5` it sends no temperature, top-k, or top-p at all: its `modelSupportsSamplingParams` check returns false for that model. The workflow sets none, since they would have no effect.
- **Jev triage that fails open, over letting the agent judge every message**: A separate model answers five yes/no questions before the agent runs, so alerts and the `blocked` reply don’t depend on the agent’s own judgment. When Jev fails or answers incompletely, the scores are `null` and the message reaches the agent with `triage_failed: true`. A TypeSafe outage can’t silence the assistant, and the prompt still tells the agent to alert the team itself.
- **No retry on the AI Agent, over Retry On Fail**: A retry re-runs the whole agent, including tools that already booked an appointment or sent an alert. The model call already retries transient API errors within one run. With `onError: continueErrorOutput`, a failure inside a run takes the error output. A sub-node that can’t load, such as a model without its credential, sends the input out of the success output instead, so `Did the agent reply` follows the agent to catch both.
- **Two retry exceptions, over 3 tries 1000 ms apart everywhere**: Jev gets 2 tries, because triage runs before every reply, and 2 tries with a 3000 ms timeout already add up to about 7s. The WhatsApp send gets 3 tries, 2000 ms apart, a task-level exception to the 1000 ms default; a send that still fails loses the reply and fails into `error-handler`.
- **Each sub-workflow loads its own context, over receiving it from the caller**: Every tool runs on its own, whether the agent or the dev harness calls it, so each one reads the mounted files through `load-context`. The cost is one `load-context` sub-execution, with four small file reads, per call.
- **Postgres node typeVersion 2.8 wherever a parameter takes free text, over 2.5 to 2.7**: From 2.8, each `{{ }}` expression in Query Parameters binds exactly one value. Versions 2.5 to 2.7 split a string result on commas, so “Hi, I’d like a cleaning, please” turns into three values, and a test with 2.7 broke the insert. The n8n-aware validator flags 2.8 as unknown; that’s its older node database, not a workflow error.
- **Alerts claimed only after they send, over a fixed “team notified” reply**: `team_notified: true` appears only when `notify-team` returned `ok: true`. After an agent failure, the patient sees `technical_issue` (“Our team has been notified…”) only if that alert sent, and `technical_issue_retry` otherwise. Triage notes give guidance only: the TEAM ALERTED note joins them only when the emergency or handoff alert sent, and otherwise the agent calls `notify_team` itself.
- **An `inquiry` update keeps the stored status, over last write wins**: The agent’s `upsert_patient` tool always sends `inquiry`, including for patients who are already `booked` or `handed_off`. So `inquiry` keeps a stored status, while `booked` and `handed_off` overwrite it.
- **One `process-message` run per WhatsApp change, over one per webhook call**: Meta can batch more than one change into one call, and the trigger emits one item per change. `process-message` handles one item by design, and Execute Workflow’s default `once` mode would merge a batch into one run, so `whatsapp-entry` runs it with `mode: each`.
- **Postgres chat memory, over n8n’s in-process Simple Memory**: History in Postgres survives n8n restarts, and every queue-mode worker reads the same history. It also sits next to `inbound_messages`, so one retention rule prunes both.
- **Business content in mounted files, over a Config node**: The business facts, knowledge base, and prompt are plain files in git, checked by `tests/content.test.ts`, so changing a price or a prompt rule changes no workflow JSON. `config/config.json` is per-instance and gitignored, which keeps instance IDs out of the committed workflows.
- **Fixed IDs, over IDs that n8n assigns on import**: `scripts/manifest.ts` fixes every workflow and credential ID, so Execute Workflow references, credential references, and `errorWorkflow` stay valid across exports and fresh installs. `npm run check` rejects an unknown credential ID.
- **Idempotency enforced by the database, over checking first**: `message_id` is the primary key, and one statement inserts with `ON CONFLICT DO NOTHING` and counts the rows it added. Two concurrent deliveries of one message can’t both pass, which a `SELECT` before an `INSERT` would allow.
- **Code nodes generated from TypeScript, over hand-written JavaScript**: Each Code node’s logic is a pure `run()` in `src/nodes/*.ts`, typed, linted, and unit-tested, and `npm run build:workflows` bundles it into the node with esbuild. CI’s `--check` run proves the committed JSON matches the source, and `npm run check` rejects any Code node missing from `CODE_NODES`. The cost is a build step and a workaround for the sandbox’s disabled `Object.defineProperty`.
- **Publishing held back only by missing trigger credentials, over waiting for every credential**: `npm run setup` publishes every workflow except one whose trigger needs a credential that isn’t set. A trigger can’t activate without it: the WhatsApp Trigger, for example, registers its subscription with Meta on activation. Without third-party credentials, every external call fails as it would in an outage, so offline dev-harness calls exercise the real failure paths.
- **A static dev-harness path, over `dev/:target`**: n8n serves a path with a route parameter under the node’s webhook ID, as `/webhook/40000000-aaaa-4bbb-8ccc-000000000001/dev/:target`, so a tunnel rule naming `/webhook/dev` would miss it. A static `/webhook/dev`, with the target in the body, keeps the harness at one predictable URL that a rule can block.
