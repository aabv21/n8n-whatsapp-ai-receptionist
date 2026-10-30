# Cumbident WhatsApp AI Receptionist

**Demo**

An n8n WhatsApp assistant that answers a dental studio's questions, books appointments in Google Calendar, and hands patients to staff when needed.

## Status

In progress: local runtime and toolchain.

### What works now

- A strict TypeScript toolchain: `typecheck`, `lint`, and `test` scripts.
- The local runtime: Postgres and n8n in Docker Compose, with separate, least-privilege database roles for n8n and the application.
- An optional `tunnel` profile that exposes n8n through ngrok, restricted to forwarding webhook traffic only.

## Quick start

```bash
cp .env.example .env
cp config/config.example.json config/config.json
npm ci
docker compose up -d --wait
npm test
```

Fill in the generated secrets in `.env` before bringing up the stack (see `.env.example` for what's required).

## License

MIT — see [LICENSE](./LICENSE).
