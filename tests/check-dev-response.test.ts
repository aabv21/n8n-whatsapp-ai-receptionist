import { describe, expect, it } from 'vitest';
import { isPastDateRejected, isRetentionSuccess } from '../scripts/check-dev-response.ts';

describe('isRetentionSuccess', () => {
  it('accepts the exact shape the Postgres node synthesizes for a DELETE with nothing to return', () => {
    expect(isRetentionSuccess({ success: true })).toBe(true);
  });

  it('rejects success: false', () => {
    expect(isRetentionSuccess({ success: false })).toBe(false);
  });

  it('rejects an extra key', () => {
    expect(isRetentionSuccess({ success: true, extra: 1 })).toBe(false);
  });

  it('rejects a non-boolean success value', () => {
    expect(isRetentionSuccess({ success: 'true' })).toBe(false);
  });

  it('rejects null, arrays, and primitives', () => {
    expect(isRetentionSuccess(null)).toBe(false);
    expect(isRetentionSuccess([])).toBe(false);
    expect(isRetentionSuccess('success')).toBe(false);
    expect(isRetentionSuccess(undefined)).toBe(false);
  });

  it('rejects an error shape like { error: "unknown_target" }', () => {
    expect(isRetentionSuccess({ error: 'unknown_target' })).toBe(false);
  });
});

describe('isPastDateRejected', () => {
  it('accepts the exact shape compute-free-slots.ts returns for a date before today', () => {
    expect(isPastDateRejected({ ok: false, reason: 'past_date' })).toBe(true);
  });

  it('rejects ok: true', () => {
    expect(isPastDateRejected({ ok: true, reason: 'past_date' })).toBe(false);
  });

  it('rejects a different reason, like an invalid date shape', () => {
    expect(isPastDateRejected({ ok: false, reason: 'invalid_date' })).toBe(false);
    expect(isPastDateRejected({ ok: false, reason: 'closed' })).toBe(false);
    expect(isPastDateRejected({ ok: false, reason: 'no_slots' })).toBe(false);
  });

  it('rejects an extra key', () => {
    expect(isPastDateRejected({ ok: false, reason: 'past_date', extra: 1 })).toBe(false);
  });

  it('rejects null, arrays, and primitives', () => {
    expect(isPastDateRejected(null)).toBe(false);
    expect(isPastDateRejected([])).toBe(false);
    expect(isPastDateRejected('past_date')).toBe(false);
    expect(isPastDateRejected(undefined)).toBe(false);
  });

  it('rejects a success shape, like an open future date with slots', () => {
    expect(isPastDateRejected({ ok: true, date: '2030-01-07', slots: [] })).toBe(false);
  });
});
