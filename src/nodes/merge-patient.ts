/** The statuses a Patients row can hold; `Validate input` accepts exactly these. */
export const PATIENT_STATUSES = ['inquiry', 'booked', 'handed_off'] as const;

export interface MergePatientInput {
  /** The update the agent or the booking flow sent. */
  update: { phone: string; status: string; name?: unknown; service_of_interest?: unknown; last_appointment?: unknown };
  /** The stored row, or the empty placeholder a first-time patient's lookup gives. */
  stored: { status?: unknown; name?: unknown; service_of_interest?: unknown; last_appointment?: unknown };
  /** Today's date in the business timezone, as `yyyy-LL-dd`. */
  today: string;
}

export interface MergedPatient {
  last_contact: string;
  phone: string;
  status: string;
  name: string;
  service_of_interest: string;
  last_appointment: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');

/** A blank or whitespace-only update keeps the stored value: nothing needs to clear a field. */
const keepStored = (update: unknown, stored: unknown): string => text(update) || text(stored);

/**
 * The row to write: the update over the stored row, field by field. A blank field keeps its
 * stored value, because Google Sheets writes an empty string for a mapped column that's blank. An
 * `inquiry` keeps a stored non-empty status, so the assistant's routine upsert never downgrades
 * `booked` or `handed_off`. `last_contact` is `today`.
 */
export function run(input: MergePatientInput): MergedPatient {
  const { update, stored, today } = input;
  const storedStatus = text(stored.status);
  return {
    last_contact: today,
    phone: update.phone,
    status: update.status === 'inquiry' && storedStatus !== '' ? storedStatus : update.status,
    name: keepStored(update.name, stored.name),
    service_of_interest: keepStored(update.service_of_interest, stored.service_of_interest),
    last_appointment: keepStored(update.last_appointment, stored.last_appointment),
  };
}
