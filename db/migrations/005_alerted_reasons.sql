-- notify-team's cooldown is per phone and per reason, so "Mark team alerted" now keeps every reason
-- it marks on a message in triage->'alerted_reasons' (a JSON array of text), next to the latest one
-- in triage->>'alerted_reason'. This backfills the list from the latest reason for every alert
-- marked before the change, so the cooldown still holds back a repeat inside its window.
-- Safe to run twice: it only touches a mark that has no list yet.
UPDATE inbound_messages
SET triage = triage || jsonb_build_object('alerted_reasons', jsonb_build_array(triage->>'alerted_reason'))
WHERE triage->>'team_alerted' = 'true'
  AND triage->>'alerted_reason' IS NOT NULL
  AND NOT (triage ? 'alerted_reasons');
