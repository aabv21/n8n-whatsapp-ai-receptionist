# Cumbident WhatsApp AI Receptionist

**Demo**

An n8n WhatsApp assistant that answers a dental studio's questions, books appointments in Google Calendar, and hands patients to staff when needed.

## Status

In progress: local runtime, toolchain, and workflow tooling/CI.

### What works now

- A strict TypeScript toolchain: `typecheck`, `lint`, and `test` scripts.
- The local runtime: Postgres and n8n in Docker Compose, with separate, least-privilege database roles for n8n and the application.
- An optional `tunnel` profile that exposes n8n through ngrok, restricted to forwarding webhook traffic only.
- Workflow tooling: a manifest of fixed workflow and credential IDs, hygiene checks that reject pinned data, literal secrets, and hand-written Code nodes, and a Code-node build that compiles `src/nodes/*.ts` into Code-node JavaScript with esbuild.
- Scripts to set up credentials and import, export, and publish workflows against the local n8n instance, plus a dev-harness client for calling a sub-workflow directly during offline testing.
- A GitHub Actions pipeline: the full quality gate, ShellCheck, gitleaks, `npm audit`, actionlint, zizmor, and a CodeQL scan (turns on once the repo is public).

## Quick start

```bash
cp .env.example .env
cp config/config.example.json config/config.json
npm ci
docker compose up -d --wait
npm test
```

Fill in the generated secrets in `.env` before bringing up the stack (see `.env.example` for what's required).

Once n8n is up, `npm run setup` imports whichever credentials already have their `.env` values filled and publishes any workflows already in `workflows/` — both are empty until later tasks add real content. See `AGENTS.md` for the full command list.

## License

MIT — see [LICENSE](./LICENSE).
