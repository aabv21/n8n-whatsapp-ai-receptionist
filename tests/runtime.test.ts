import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const compose = readFileSync('compose.yaml', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');
const policy = readFileSync('ngrok/traffic-policy.yml', 'utf8');
const config: unknown = JSON.parse(readFileSync('config/config.example.json', 'utf8'));
const service = (name: string): string =>
  compose.split(/^ {2}(?=[a-z][\w-]*:$)/m).find((block) => block.startsWith(`${name}:`)) ?? '';

test('every variable compose reads is in .env.example', () => {
  const used = [...compose.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]);
  const declared = new Set([...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  expect(used.filter((name) => !declared.has(name))).toEqual([]);
});
test('images are pinned', () => {
  expect(service('n8n')).toContain('image: n8nio/n8n:2.45.6');
  expect(service('postgres')).toContain('image: postgres:17-alpine');
});
test('n8n never sees the Postgres superuser', () => {
  expect(service('n8n')).toContain('DB_POSTGRESDB_USER: ${N8N_DB_USER}');
  expect(service('n8n')).not.toMatch(/POSTGRES_(USER|PASSWORD)/);
});
test('the tunnel forwards webhooks only', () => {
  expect(policy).toContain(`!req.url.path.startsWith('/webhook/')`);
  expect(policy).toContain(`req.url.path == '/webhook/dev' || req.url.path.startsWith('/webhook/dev/')`);
  expect(policy).toContain(`req.url.path.contains('//')`);
  expect(service('ngrok')).toContain('./ngrok/traffic-policy.yml:/etc/ngrok/traffic-policy.yml:ro');
});
test('config example carries the starting thresholds', () => expect(config).toEqual({
  google: { calendar_id: 'REPLACE_ME', patients_sheet_id: 'REPLACE_ME', patients_tab: 'Patients' },
  team_email: 'team@example.com',
  triage: {
    model: 'jev-1.14.0', timeout_ms: 3000,
    thresholds: { emergency: 0.6, asks_for_human: 0.7, complaint: 0.7, medical_advice: 0.7, manipulation: 0.85 },
  },
  limits: { max_messages_per_window: 20, window_minutes: 10, retention_days: 30, max_text_chars: 2000 },
}));
