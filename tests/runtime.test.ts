import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { readWorkflow } from '../scripts/lib/workflow.ts';
import { normalizeLocale } from '../src/nodes/shared/locale.ts';

const compose = readFileSync('compose.yaml', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');
const policy = readFileSync('ngrok/traffic-policy.yml', 'utf8');
const config: unknown = JSON.parse(readFileSync('config/config.example.json', 'utf8'));
const whatsappTrigger = readWorkflow('workflows/whatsapp-entry.json').nodes.find((n) => n.type === 'n8n-nodes-base.whatsAppTrigger');
const triggerWebhookId = typeof whatsappTrigger?.webhookId === 'string' ? whatsappTrigger.webhookId : '';
const service = (name: string): string =>
  compose.split(/^ {2}(?=[a-z][\w-]*:$)/m).find((block) => block.startsWith(`${name}:`)) ?? '';

test('every variable compose reads is in .env.example', () => {
  const used = [...compose.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]);
  const declared = new Set([...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  expect(used.filter((name) => !declared.has(name))).toEqual([]);
});
test('images are pinned', () => {
  // Patches on the 2.45 line arrive through Dependabot; a minor or major move is a deliberate change.
  expect(service('n8n')).toMatch(/image: n8nio\/n8n:2\.45\.\d+@sha256:[0-9a-f]{64}/);
  expect(service('postgres')).toContain('image: postgres:17-alpine');
});
test('n8n never sees the Postgres superuser', () => {
  expect(service('n8n')).toContain('DB_POSTGRESDB_USER: ${N8N_DB_USER}');
  expect(service('n8n')).not.toMatch(/POSTGRES_(USER|PASSWORD)/);
});
test('the tunnel policy pins the WhatsApp trigger path and denies unsafe encodings', () => {
  expect(triggerWebhookId).not.toBe('');
  expect(policy).toContain(`req.url.raw_path.matches("^/webhook/${triggerWebhookId}/webhook$")`);
  expect(policy).toContain(`req.url.raw_path.contains("%")`);
  expect(policy).toContain(`req.url.raw_path.contains("\\\\")`);
  expect(policy).toContain(`req.url.raw_path.contains("//")`);
  expect(policy).toContain(`req.url.raw_path.contains("/./")`);
  expect(policy).toContain(`req.url.raw_path.contains("/../")`);
  expect(service('ngrok')).toContain('./ngrok/traffic-policy.yml:/etc/ngrok/traffic-policy.yml:ro');
});
test('n8n caps its payload size well above a real WhatsApp webhook but well below the default', () => {
  expect(service('n8n')).toContain('N8N_PAYLOAD_SIZE_MAX: "2"');
});
test('the tunnel disables request inspection, since captured requests hold patient messages', () => {
  expect(service('ngrok')).toContain('--inspect=false');
});
test("the tunnel policy rate-limits by client IP, after the deny rules, well above a small clinic's delivery rate", () => {
  expect(policy).toContain('type: rate-limit');
  expect(policy).toContain('algorithm: sliding_window');
  expect(policy).toContain('capacity: 60');
  expect(policy).toContain('rate: 60s');
  expect(policy).toContain('- conn.client_ip');
  // Only a request that passed both deny rules counts against the limit.
  expect(policy.indexOf('type: rate-limit')).toBeGreaterThan(policy.lastIndexOf('type: deny'));
});
test('the webhook allowlist regex only accepts the WhatsApp trigger path', () => {
  const source = /\.matches\("([^"]+)"\)/.exec(policy)?.[1] ?? '';
  expect(source).toBe(`^/webhook/${triggerWebhookId}/webhook$`);
  // eslint-disable-next-line security/detect-non-literal-regexp -- source is extracted from our own committed traffic policy, not user input
  const allowlist = new RegExp(source);
  expect(allowlist.test(`/webhook/${triggerWebhookId}/webhook`)).toBe(true);
  expect(allowlist.test('/webhook/dev')).toBe(false);
  expect(allowlist.test('/webhook/0b5e8f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b/webhook')).toBe(false);
  expect(allowlist.test(`/Webhook/${triggerWebhookId}/webhook`)).toBe(false);
  expect(allowlist.test(`/webhook/${triggerWebhookId}/webhook/extra`)).toBe(false);
  expect(allowlist.test('/rest/login')).toBe(false);
});
test("config example's locale settings each name a supported language", () => {
  const { locale, team_locale } = config as { locale: { default: unknown }; team_locale: unknown };
  expect([normalizeLocale(locale.default), normalizeLocale(team_locale)]).toEqual(['es', 'en']);
});
test('config example carries the starting thresholds', () => expect(config).toEqual({
  google: { calendar_id: 'REPLACE_ME', patients_sheet_id: 'REPLACE_ME', patients_tab: 'Patients' },
  team_email: 'team@example.com',
  team_locale: 'en',
  locale: { default: 'es' },
  triage: {
    model: 'jev-1.14.0', timeout_ms: 3000,
    thresholds: { emergency: 0.6, asks_for_human: 0.7, complaint: 0.7, medical_advice: 0.7, manipulation: 0.85 },
  },
  limits: {
    max_messages_per_window: 20, window_minutes: 10, retention_days: 30, max_text_chars: 2000,
    alert_cooldown_minutes: 60, max_booking_days_ahead: 60, max_upcoming_bookings: 3,
  },
}));

// Compose's default 10 s would kill executions n8n is still finishing on a stop or restart.
test('n8n gets its full 30 s graceful shutdown', () => {
  expect(service('n8n')).toContain('stop_grace_period: 30s');
});

// Prose names the pinned line ("the n8n 2.45 line"), so a Dependabot patch bump never makes the docs
// wrong. An exact patch appears only in a dated note recording which image a claim was checked against.
test('an n8n 2.45 patch appears only in a dated "checked against" note', async () => {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard']);
  const skipped = (file: string): boolean =>
    ['pnpm-lock.yaml', 'compose.yaml', 'tests/runtime.test.ts'].includes(file) || /^docs\/diagrams\/[^/]+\.(?:html|svg)$/.test(file);
  const offenders: string[] = [];
  for (const file of stdout.split('\n').filter((f) => f && !skipped(f))) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // a file deleted in the working tree but still in the index
    }
    for (const match of content.matchAll(/2\.45\.\d+/g)) {
      const before = content.slice(Math.max(0, match.index - 40), match.index + match[0].length + 20);
      if (!/checked against n8n `2\.45\.\d+` on \d{4}-\d{2}-\d{2}/.test(before)) offenders.push(`${file}: ${match[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
