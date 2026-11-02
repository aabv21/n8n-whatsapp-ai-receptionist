-- inbound_messages.route holds what process-message's "Save route" writes: one of
-- src/nodes/decide-route.ts's routes (agent, blocked, emergency, handoff), or one of
-- process-message's own fixed routes (fallback, non_text, rate_limited). It stays NULL until then,
-- and for a duplicate, which is never saved. tests/db-migrate.test.ts pins this list to both.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inbound_messages'::regclass AND conname = 'inbound_messages_route_check'
  ) THEN
    ALTER TABLE inbound_messages ADD CONSTRAINT inbound_messages_route_check CHECK (
      route IS NULL OR route IN ('agent', 'blocked', 'emergency', 'handoff', 'fallback', 'non_text', 'rate_limited')
    );
  END IF;
END
$$;
