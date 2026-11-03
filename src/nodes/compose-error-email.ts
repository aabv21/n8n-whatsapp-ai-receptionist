import { INVALID_TEAM_LOCALE_NOTE, localTime, plain, teamMessages } from './shared/team-messages.ts';

export interface ErrorEmailInput {
  workflow_name: string;
  last_node: string;
  error_message: string;
  execution_url: string;
  /** The current time as ISO 8601, from the workflow, since a Code node reads no clock. */
  now: string;
  timezone: string;
  /** `config.team_locale`. */
  team_locale: unknown;
}

/**
 * The plain-text failure email the error handler sends, in `config.team_locale`'s language. The
 * error message stays as n8n wrote it. An invalid `team_locale` still sends, in English, since this
 * email is how the team hears about every other failure.
 */
export function run(input: ErrorEmailInput): { subject: string; body: string } {
  const { messages, invalid } = teamMessages(input.team_locale);
  const lines = [
    `${messages.failedNode}: ${plain(input.last_node)}`,
    `${messages.error}: ${plain(input.error_message)}`,
    `${messages.execution}: ${plain(input.execution_url)}`,
    `${messages.time}: ${localTime(input.now, input.timezone)}`,
  ];
  if (invalid) lines.push('', INVALID_TEAM_LOCALE_NOTE);
  return { subject: `[Cumbident demo] ${messages.workflowFailed}: ${plain(input.workflow_name)}`, body: lines.join('\n') };
}
