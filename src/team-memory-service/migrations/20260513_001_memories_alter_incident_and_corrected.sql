
BEGIN;

ALTER TABLE team_memory.memories
  ADD COLUMN IF NOT EXISTS last_corrected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_memories_last_corrected
  ON team_memory.memories USING btree (last_corrected_at DESC)
  WHERE (t_invalid IS NULL AND last_corrected_at IS NOT NULL);

ALTER TABLE team_memory.memories
  DROP CONSTRAINT IF EXISTS memories_type_check;

ALTER TABLE team_memory.memories
  ADD CONSTRAINT memories_type_check
  CHECK (type = ANY (ARRAY[
    'snapshot'::text,
    'pointer'::text,
    'rule'::text,
    'playbook'::text,
    'decision'::text,
    'feedback'::text,
    'user'::text,
    'general'::text,
    'incident'::text,
    'reference'::text,
    'correction'::text
  ]));

COMMIT;

