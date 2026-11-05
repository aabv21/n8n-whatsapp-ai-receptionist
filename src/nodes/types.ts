import type { Localized } from './shared/locale.ts';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface Service {
  /** The canonical name every tool call and Calendar event uses. */
  name: string;
  /**
   * The name shown to a patient in each language; `en` is `name` itself. tests/content.test.ts
   * requires it, but business.json is edited by hand, so the Code nodes tolerate it missing.
   */
  name_i18n?: Localized;
  price_cop: number;
}

export interface Business {
  name: string;
  description: string;
  address: string;
  timezone: string;
  currency: string;
  hours: Record<Weekday, [string, string] | null>;
  appointment_minutes: number;
  max_slots_offered: number;
  min_notice_minutes: number;
  payment_methods: string[];
  services: Service[];
  replies: Record<ReplyKey, Localized>;
}

/** Every fixed patient reply in `business.json`, each written in every supported language. */
export const REPLY_KEYS = [
  'non_text',
  'blocked',
  'rate_limited',
  'technical_issue',
  'technical_issue_retry',
  'medical_advice',
  'price_check',
] as const;

export type ReplyKey = (typeof REPLY_KEYS)[number];
