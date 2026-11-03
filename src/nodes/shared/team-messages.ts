import { localeSetting, pick, type Lang } from './locale.ts';

/** Every reason notify-team accepts; anything else reads as `other`. */
export const ALERT_REASONS = ['emergency', 'human_requested', 'complaint', 'unknown_treatment', 'out_of_scope', 'tool_failure', 'other'] as const;

export type AlertReason = (typeof ALERT_REASONS)[number];

export interface TeamMessages {
  reasons: Record<AlertReason, string>;
  reason: string;
  name: string;
  notGiven: string;
  phone: string;
  summary: string;
  none: string;
  time: string;
  recentMessages: string;
  workflowFailed: string;
  failedNode: string;
  error: string;
  execution: string;
}

/** The text of every email sent to the team, in `config.team_locale`'s language. */
export const TEAM_MESSAGES: Record<Lang, TeamMessages> = {
  en: {
    reasons: {
      emergency: 'Dental emergency',
      human_requested: 'Patient asked for a person',
      complaint: 'Complaint',
      unknown_treatment: "Asked about a treatment we don't list",
      out_of_scope: "Question the assistant couldn't answer",
      tool_failure: 'Assistant tool failure',
      other: 'Needs attention',
    },
    reason: 'Reason',
    name: 'Name',
    notGiven: '(not given)',
    phone: 'Phone',
    summary: 'Summary',
    none: '(none)',
    time: 'Time',
    recentMessages: 'Recent messages',
    workflowFailed: 'Workflow failed',
    failedNode: 'Failed node',
    error: 'Error',
    execution: 'Execution',
  },
  es: {
    reasons: {
      emergency: 'Urgencia odontológica',
      human_requested: 'El paciente pidió hablar con una persona',
      complaint: 'Queja',
      unknown_treatment: 'Preguntó por un tratamiento que no ofrecemos',
      out_of_scope: 'Pregunta que el asistente no pudo responder',
      tool_failure: 'Falla de una herramienta del asistente',
      other: 'Requiere atención',
    },
    reason: 'Motivo',
    name: 'Nombre',
    notGiven: '(no lo indicó)',
    phone: 'Teléfono',
    summary: 'Resumen',
    none: '(ninguno)',
    time: 'Hora',
    recentMessages: 'Mensajes recientes',
    workflowFailed: 'Falló un flujo',
    failedNode: 'Nodo que falló',
    error: 'Error',
    execution: 'Ejecución',
  },
};

/**
 * Added, in English, to an email whose `config.team_locale` names no supported language. Unlike
 * process-message, a team email never stops over it: a dental emergency still reaches the team.
 */
export const INVALID_TEAM_LOCALE_NOTE = 'Note: config.team_locale must be "en" or "es", so this email is in English.';

/** The messages for `config.team_locale` (English when it isn't set), and whether the setting was invalid. */
export function teamMessages(teamLocale: unknown): { messages: TeamMessages; invalid: boolean } {
  const lang = localeSetting(teamLocale, 'en');
  return { messages: pick(TEAM_MESSAGES, lang ?? 'en'), invalid: lang === null };
}

/** A string input as given, a number as its digits, and anything else (missing, null, an object) as empty. */
export function plain(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' ? String(value) : '';
}

/** `now` in `timezone`, as `yyyy-LL-dd HH:mm <zone>`: numeric, so it reads the same in every language. */
export function localTime(now: string, timezone: string): string {
  return `${DateTime.fromISO(now, { zone: timezone }).toFormat('yyyy-LL-dd HH:mm')} ${timezone}`;
}
