import type { DateTime as LuxonDateTime } from 'luxon';

// The n8n Code-node sandbox injects Luxon's DateTime as a global, with no import or require;
// `tests/setup.ts` provides it in tests.
declare global {
  var DateTime: typeof LuxonDateTime;
  type DateTime = LuxonDateTime;
}
