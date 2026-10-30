# Cumbident WhatsApp AI Receptionist

**Demo**

An n8n WhatsApp assistant that answers a dental studio's questions, books appointments in Google Calendar, and hands patients to staff when needed.

## Status

In progress: local runtime, toolchain, workflow tooling/CI, the business content and system prompt, and the platform workflows every other workflow relies on.

### What works now

- A strict TypeScript toolchain: `typecheck`, `lint`, and `test` scripts.
- The local runtime: Postgres and n8n in Docker Compose, with separate, least-privilege database roles for n8n and the application.
- An optional `tunnel` profile that exposes n8n through ngrok, restricted to forwarding webhook traffic only.
- Workflow tooling: a manifest of fixed workflow and credential IDs, hygiene checks that reject pinned data, literal secrets, and hand-written Code nodes, and a Code-node build that compiles `src/nodes/*.ts` into Code-node JavaScript with esbuild.
- Scripts to set up credentials and import, export, and publish workflows against the local n8n instance, plus a dev-harness client for calling a sub-workflow directly during offline testing.
- A GitHub Actions pipeline: the full quality gate, ShellCheck, gitleaks, `npm audit`, actionlint, zizmor, and a CodeQL scan (turns on once the repo is public).
- Business content the workflows load at runtime: `business/business.json` (the facts — address, hours, prices, payment methods, fixed replies), `business/knowledge-base.md` (FAQ prose), and `prompts/system-prompt.md` (the assistant's system prompt template, with `<<BUSINESS>>`, `<<KNOWLEDGE_BASE>>`, `<<NOW>>`, and `<<TRIAGE_NOTES>>` placeholders), all checked by `tests/content.test.ts`.
- The four platform workflows every other workflow depends on: `load-context` (reads the business content above into one item), `error-handler` (emails the team when any other workflow fails), `notify-team` (alerts the team by email for a flagged conversation), and the token-protected `dev-harness`, which lets `node scripts/dev-call.ts <target> '<json>'` call any of these directly over HTTP without WhatsApp or the n8n editor.

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
```

The second call answers `{"ok":false,"reason":"email_failed"}` until a real Gmail credential exists — that's the expected offline result, not a bug. See `AGENTS.md` for the full command list.

## License

MIT — see [LICENSE](./LICENSE).
