
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS team_memory;

CREATE TABLE IF NOT EXISTS team_memory.memories (
  id BIGSERIAL PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,                    -- content hash 防重复 store（sha256 前 16 hex）

  name TEXT,                                    -- 可读名
  description TEXT,                             -- 一句话钩子（索引里显示）
  content TEXT NOT NULL,
  summary TEXT,                                 -- 一句话摘要（generic 风格）

  type TEXT NOT NULL DEFAULT 'rule'
    CHECK (type IN ('snapshot', 'pointer', 'rule', 'playbook', 'decision', 'feedback', 'user', 'general')),
  topic TEXT,
  scope TEXT NOT NULL DEFAULT 'all-agents',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'planned', 'draft', 'archived')),

  t_valid TIMESTAMPTZ NOT NULL DEFAULT now(),
  t_invalid TIMESTAMPTZ,                        -- NULL 表示仍有效；supersedes 时设
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),

  maturity TEXT NOT NULL DEFAULT 'draft'
    CHECK (maturity IN ('draft', 'verified', 'proven')),
  requires_review BOOLEAN NOT NULL DEFAULT FALSE,  -- decision 类自动设 true，approver ack 后转 false
  last_verified DATE,

  importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  memory_level TEXT NOT NULL DEFAULT 'semi_abstract'
    CHECK (memory_level IN ('concrete_trace', 'semi_abstract', 'meta_knowledge')),
  category TEXT NOT NULL DEFAULT 'general',

  author_agent_id UUID,                         -- 谁 store 的
  source_file TEXT,                             -- 原 .md 文件相对路径（import 用，新写入留 NULL）
  supersedes BIGINT[] DEFAULT '{}',             -- 取代了哪些旧记忆 id
  related BIGINT[] DEFAULT '{}',                -- 相关记忆 id
  ref_links TEXT[] DEFAULT '{}',                -- 外部链接（PR / commit / 文档 URL）—— 注：避开 SQL 关键字 references
  authoritative_sources TEXT[] DEFAULT '{}',    -- pointer 类的真理源 URL

  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',

  content_vector vector(1024),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_type
  ON team_memory.memories (type) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_status
  ON team_memory.memories (status) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_maturity
  ON team_memory.memories (maturity) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_topic
  ON team_memory.memories (topic) WHERE t_invalid IS NULL AND topic IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_scope
  ON team_memory.memories (scope) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_created
  ON team_memory.memories (created_at DESC) WHERE t_invalid IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_importance
  ON team_memory.memories (importance DESC) WHERE t_invalid IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_tsv
  ON team_memory.memories USING gin (to_tsvector('simple', coalesce(content, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(name, '')))
  WHERE t_invalid IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_tags
  ON team_memory.memories USING gin (tags) WHERE t_invalid IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_vec
  ON team_memory.memories USING ivfflat (content_vector vector_cosine_ops) WITH (lists = 100);


CREATE TABLE IF NOT EXISTS team_memory.recall_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'unknown',       -- mcp / cli / prompt-recall-hook / etc
  agent_id UUID,
  agent_name TEXT,                              -- 冗余存名字方便人看
  session_id TEXT,
  query TEXT,
  hit_ids BIGINT[] DEFAULT '{}',
  hit_count INTEGER NOT NULL DEFAULT 0,         -- raw 候选池数
  final_hit_count INTEGER,                      -- hook 后置过滤后真注入数（fire-and-forget update）
  duration_ms INTEGER,
  filter_level TEXT,
  filter_min_importance INTEGER,
  query_path TEXT NOT NULL DEFAULT 'hybrid'     -- hybrid / fts / vec / strict
);

CREATE INDEX IF NOT EXISTS idx_recall_log_ts
  ON team_memory.recall_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_recall_log_agent_session
  ON team_memory.recall_log (agent_id, session_id, ts DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recall_log_source
  ON team_memory.recall_log (source, ts DESC);


CREATE TABLE IF NOT EXISTS team_memory.promotion_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  memory_id BIGINT NOT NULL REFERENCES team_memory.memories(id) ON DELETE CASCADE,
  from_maturity TEXT NOT NULL,
  to_maturity TEXT NOT NULL,
  approved_by UUID,                             -- approver ack proven 时填，draft→verified 由 owner 显式 promote（ADR-047 退役了自动 cron）
  approved_by_name TEXT,
  reason TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_promotion_log_memory
  ON team_memory.promotion_log (memory_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_promotion_log_ts
  ON team_memory.promotion_log (ts DESC);


CREATE OR REPLACE FUNCTION team_memory.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memories_set_updated_at ON team_memory.memories;
CREATE TRIGGER trg_memories_set_updated_at
  BEFORE UPDATE ON team_memory.memories
  FOR EACH ROW EXECUTE FUNCTION team_memory.set_updated_at();

SELECT '✓ team_memory schema 主表 + recall_log + promotion_log + trigger 全部就绪' AS status;
