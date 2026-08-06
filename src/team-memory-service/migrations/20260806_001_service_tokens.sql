
CREATE TABLE IF NOT EXISTS team_memory.service_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid        NOT NULL,
  agent_name    text        NOT NULL,
  token_hash    text        NOT NULL UNIQUE,
  note          text,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  last_used_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_service_tokens_hash      ON team_memory.service_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_service_tokens_principal ON team_memory.service_tokens (principal_id);

COMMENT ON TABLE team_memory.service_tokens IS
  'KOS 自有 agent 凭据（2026-08-06）。发放：生成明文 cgt_<64hex>，只存 sha256。吊销：set revoked_at。权限另配 TM_MEMORY_AUTHZ_GRANTS.by_resident_id[principal_id]。';
