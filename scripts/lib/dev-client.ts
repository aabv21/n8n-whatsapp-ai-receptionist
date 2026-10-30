import { loadDotEnv } from './runtime.ts';

export async function callDev(target: string, input: unknown): Promise<unknown> {
  loadDotEnv();
  const n8nUrl = process.env.N8N_URL;
  if (!n8nUrl) throw new Error('N8N_URL is not set');

  const res = await fetch(`${n8nUrl}/webhook/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Dev-Token': process.env.DEV_HARNESS_TOKEN ?? '' },
    body: JSON.stringify({ target, input }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${String(res.status)} ${await res.text()}`);
  return res.json();
}
