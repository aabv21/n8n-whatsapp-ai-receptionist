import type { ToolCall } from '../collect-tool-calls.ts';

/** The agent tool that books an appointment: its name in `process-message`'s tool nodes. */
export const BOOK_APPOINTMENT_TOOL = 'book_appointment';

/** The agent tool that cancels one of the patient's appointments. */
export const CANCEL_APPOINTMENT_TOOL = 'cancel_appointment';

/** The agent tool that moves one of the patient's appointments. */
export const RESCHEDULE_APPOINTMENT_TOOL = 'reschedule_appointment';

/** The output of each call to `tool` that returned an object, in call order. */
export function toolResults(toolCalls: readonly ToolCall[], tool: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const call of toolCalls) {
    if (call.tool === tool && typeof call.output === 'object' && call.output !== null) results.push(call.output as Record<string, unknown>);
  }
  return results;
}
