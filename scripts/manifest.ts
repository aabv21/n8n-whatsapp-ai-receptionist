export interface WorkflowEntry {
  id: string;
  name: string;
  file: string;
  /** This workflow's live webhook path, when its trigger is a plain webhook — used to confirm a publish actually took effect. */
  webhookPath?: string;
}

export interface CredentialEntry {
  id: string;
  name: string;
  type: string;
  env: readonly string[];
  data: (env: Readonly<Record<string, string>>) => Record<string, unknown>;
}

export interface CodeNodeEntry {
  file: string;
  node: string;
  source: string;
  why: string;
}

export const ERROR_WORKFLOW_ID = 'cmbErrorHandler1';
export const LOAD_CONTEXT_ID = 'cmbLoadContext01';

/** `env[key]` widened past `noUncheckedIndexedAccess`; callers only reach here once the key is known to be set. */
// eslint-disable-next-line security/detect-object-injection -- key is always one of this entry's own fixed `env` names
const readEnv = (env: Readonly<Record<string, string>>, key: string): string => env[key] ?? '';

export const WORKFLOWS: readonly WorkflowEntry[] = [
  { id: LOAD_CONTEXT_ID, name: 'Load context', file: 'load-context.json' },
  { id: ERROR_WORKFLOW_ID, name: 'Error handler', file: 'error-handler.json' },
  { id: 'cmbNotifyTeam001', name: 'Notify team', file: 'notify-team.json' },
  { id: 'cmbDevHarness001', name: 'Dev harness', file: 'dev-harness.json', webhookPath: 'dev' },
  { id: 'cmbCheckAvail001', name: 'Check availability', file: 'check-availability.json' },
  { id: 'cmbUpsertPatient', name: 'Upsert patient', file: 'upsert-patient.json' },
  { id: 'cmbBookAppt00001', name: 'Book appointment', file: 'book-appointment.json' },
  { id: 'cmbTriageMsg0001', name: 'Triage message', file: 'triage-message.json' },
  { id: 'cmbProcMessage01', name: 'Process message', file: 'process-message.json' },
  { id: 'cmbWhatsappEntry', name: 'WhatsApp entry', file: 'whatsapp-entry.json' },
  { id: 'cmbRetentionJob1', name: 'Retention cleanup', file: 'retention-cleanup.json' },
];

export const CREDENTIALS: readonly CredentialEntry[] = [
  {
    id: 'cmbCredAppDb0001',
    name: 'App DB',
    type: 'postgres',
    env: ['APP_DB_USER', 'APP_DB_PASSWORD'],
    data: (env) => ({
      host: 'postgres',
      port: 5432,
      database: 'app',
      user: readEnv(env, 'APP_DB_USER'),
      password: readEnv(env, 'APP_DB_PASSWORD'),
      ssl: 'disable',
    }),
  },
  {
    id: 'cmbCredAnthropic',
    name: 'Anthropic',
    type: 'anthropicApi',
    env: ['ANTHROPIC_API_KEY'],
    data: (env) => ({ apiKey: readEnv(env, 'ANTHROPIC_API_KEY') }),
  },
  {
    id: 'cmbCredTypeSafe1',
    name: 'TypeSafe',
    type: 'httpHeaderAuth',
    env: ['TYPESAFE_API_KEY'],
    data: (env) => ({ name: 'Authorization', value: `Bearer ${readEnv(env, 'TYPESAFE_API_KEY')}` }),
  },
  {
    id: 'cmbCredDevToken1',
    name: 'Dev harness token',
    type: 'httpHeaderAuth',
    env: ['DEV_HARNESS_TOKEN'],
    data: (env) => ({ name: 'X-Dev-Token', value: readEnv(env, 'DEV_HARNESS_TOKEN') }),
  },
  {
    id: 'cmbCredGCalendar',
    name: 'Google Calendar',
    type: 'googleCalendarOAuth2Api',
    env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    data: (env) => ({ clientId: readEnv(env, 'GOOGLE_OAUTH_CLIENT_ID'), clientSecret: readEnv(env, 'GOOGLE_OAUTH_CLIENT_SECRET') }),
  },
  {
    id: 'cmbCredGSheets01',
    name: 'Google Sheets',
    type: 'googleSheetsOAuth2Api',
    env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    data: (env) => ({ clientId: readEnv(env, 'GOOGLE_OAUTH_CLIENT_ID'), clientSecret: readEnv(env, 'GOOGLE_OAUTH_CLIENT_SECRET') }),
  },
  {
    id: 'cmbCredGmail0001',
    name: 'Gmail',
    type: 'gmailOAuth2',
    env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    data: (env) => ({ clientId: readEnv(env, 'GOOGLE_OAUTH_CLIENT_ID'), clientSecret: readEnv(env, 'GOOGLE_OAUTH_CLIENT_SECRET') }),
  },
  {
    id: 'cmbCredWhatsApp1',
    name: 'WhatsApp send',
    type: 'whatsAppApi',
    env: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_BUSINESS_ACCOUNT_ID'],
    data: (env) => ({ accessToken: readEnv(env, 'WHATSAPP_ACCESS_TOKEN'), businessAccountId: readEnv(env, 'WHATSAPP_BUSINESS_ACCOUNT_ID') }),
  },
  {
    id: 'cmbCredWaTrigger',
    name: 'WhatsApp trigger',
    type: 'whatsAppTriggerApi',
    env: ['META_APP_ID', 'META_APP_SECRET'],
    data: (env) => ({ clientId: readEnv(env, 'META_APP_ID'), clientSecret: readEnv(env, 'META_APP_SECRET') }),
  },
];

export const CODE_NODES: readonly CodeNodeEntry[] = [
  {
    // Ruling P5: runs the same slot computation with events: [] before calling Google Calendar, so
    // a closed, past, or invalid date short-circuits without an avoidable (and offline-unreachable) API call.
    file: 'check-availability.json',
    node: 'Check date',
    source: 'src/nodes/compute-free-slots.ts',
    why: 'reuses the date/hours checks from compute-free-slots so an invalid, past, or closed date is rejected before the Calendar call',
  },
  {
    file: 'check-availability.json',
    node: 'Compute free slots',
    source: 'src/nodes/compute-free-slots.ts',
    why: 'slot arithmetic over opening hours and busy events needs loops no native node expresses',
  },
  {
    file: 'book-appointment.json',
    node: 'Validate booking',
    source: 'src/nodes/validate-booking.ts',
    why: 'ordered checks of service, date, hours and notice must yield one result',
  },
  {
    file: 'triage-message.json',
    node: 'Decide route',
    source: 'src/nodes/decide-route.ts',
    why: 'ordered threshold rules pick one route with its flags and notes',
  },
  {
    file: 'process-message.json',
    node: 'Build system prompt',
    source: 'src/nodes/build-system-prompt.ts',
    why: 'prompt placeholders are filled verbatim and the local time is formatted',
  },
  {
    file: 'process-message.json',
    node: 'Collect tool calls',
    source: 'src/nodes/collect-tool-calls.ts',
    why: 'tool observations may or may not be JSON, and parsing them needs try/catch',
  },
  {
    // A delete node's success and error outputs feeding the same merge input race (n8n's internal
    // ordering decides which item arrives), so a failed delete could be reported as a success.
    // Both of cleanup's per-item delete parts route every outcome through this one decision point
    // instead, so exactly one item (a count, or null if any outcome failed) reaches the merge.
    file: 'dev-harness.json',
    node: 'Count event outcomes',
    source: 'src/nodes/count-cleanup-outcomes.ts',
    why: 'counting successes while detecting any failure among a mix of per-item delete outcomes needs a loop, not a single expression',
  },
  {
    file: 'dev-harness.json',
    node: 'Count row outcomes',
    source: 'src/nodes/count-cleanup-outcomes.ts',
    why: 'counting successes while detecting any failure among a mix of per-item delete outcomes needs a loop, not a single expression',
  },
];
