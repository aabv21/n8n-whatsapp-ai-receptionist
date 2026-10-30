export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface Service {
  name: string;
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
  replies: {
    non_text: string;
    blocked: string;
    rate_limited: string;
    technical_issue: string;
    technical_issue_retry: string;
  };
}
