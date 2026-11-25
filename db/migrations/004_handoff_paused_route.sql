-- inbound_messages.route holds what process-message's "Save route" writes: one of
-- src/nodes/decide-route.ts's routes (agent, blocked, emergency, handoff), or one of
-- process-message's own fixed routes (fallback, non_text, rate_limited, handoff_paused). It stays
-- NULL until then, and for a duplicate, which is never saved. handoff_paused marks a message the
-- assistant left unanswered because the patient is waiting for the team.
-- tests/db-migrate.test.ts pins this list to both.
-- NOTE: ADD CONSTRAINT scans inbound_messages once, under a brief exclusive lock; at this table's
-- size (see the retention window) that is milliseconds.
ALTER TABLE inbound_messages DROP CONSTRAINT IF EXISTS inbound_messages_route_check;
ALTER TABLE inbound_messages ADD CONSTRAINT inbound_messages_route_check CHECK (
  route IS NULL OR route IN ('agent', 'blocked', 'emergency', 'handoff', 'fallback', 'non_text', 'rate_limited', 'handoff_paused')
);
