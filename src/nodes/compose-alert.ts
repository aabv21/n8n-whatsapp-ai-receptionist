import { isPositiveInteger } from './shared/limits.ts';
import { ALERT_REASONS, INVALID_ALERT_COOLDOWN_NOTE, INVALID_TEAM_LOCALE_NOTE, localTime, plain, teamMessages, type AlertReason } from './shared/team-messages.ts';

export interface AlertInput {
  reason: string;
  phone: string;
  name: string;
  summary: string;
  recent_messages: unknown[];
  /** The current time as ISO 8601, from the workflow, since a Code node reads no clock. */
  now: string;
  timezone: string;
  /** `config.team_locale`. */
  team_locale: unknown;
  /** `config.limits.alert_cooldown_minutes`; anything but an integer of 1 or more adds a note. */
  alert_cooldown_minutes: unknown;
}

const isReason = (value: string): value is AlertReason => (ALERT_REASONS as readonly string[]).includes(value);

/**
 * The plain-text alert notify-team emails, in `config.team_locale`'s language. Only the labels are
 * translated: the name, summary, and messages stay exactly as the patient or the agent wrote them.
 */
export function run(input: AlertInput): { subject: string; body: string } {
  const { messages, invalid } = teamMessages(input.team_locale);
  const reasonText = plain(input.reason);
  const reason = messages.reasons[isReason(reasonText) ? reasonText : 'other'];
  const name = plain(input.name);
  const phone = plain(input.phone);
  const recent = Array.isArray(input.recent_messages) ? input.recent_messages.map(plain) : [];
  const lines = [
    `${messages.reason}: ${reason}`,
    `${messages.name}: ${name || messages.notGiven}`,
    `${messages.phone}: https://wa.me/${phone}`,
    `${messages.summary}: ${plain(input.summary) || messages.none}`,
    `${messages.time}: ${localTime(input.now, input.timezone)}`,
    '',
    `${messages.recentMessages}:`,
    recent.join('\n'),
  ];
  if (invalid) lines.push('', INVALID_TEAM_LOCALE_NOTE);
  if (!isPositiveInteger(input.alert_cooldown_minutes)) lines.push('', INVALID_ALERT_COOLDOWN_NOTE);
  return { subject: `[Cumbident] ${reason}: ${name || phone}`, body: lines.join('\n') };
}
