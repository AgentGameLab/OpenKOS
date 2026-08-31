# team-memory-service · 云端运行时召回服务

> ADR-025 落地代码 · v0.1.0 · 2026-05-08
>
> **状态**：Phase 3 框架就绪，待 ECS 部署 + nginx 反代 + agent hook 接入

---

## 是什么

把个人记忆实现已验证的 3 项强项（按需注入 / 运行时召回打点 / 程序化召回 API）补到 v1.4 team-memory：

- **HTTP MCP server** — 团队所有 agent 通过 `.mcp.json` 配 HTTPS endpoint，一键 recall / store
- **PG hybrid recall** — FTS5 + pgvector ivfflat 双路召回 + RRF 融合 + maturity 加权
- **跨 agent 流水打点** — `recall_log` 表记每次调用 source / agent_id / session_id / 命中

**不替换** v1.4 现有 bi-temporal + maturity ladder + KG（互补关系）。

---

## 架构

```
[团队 agent (cc/oc)]
   ↓ HTTPS MCP (Authorization: Bearer <KOS_SERVICE_TOKEN>)
[ECS team-memory-service:3000]   (PM2 长驻 / nginx 反代)
   ├── lib/auth.mjs         # token → agent_id (5min cache)
   ├── lib/recall.mjs       # hybrid recall + RRF 融合
   ├── lib/store.mjs        # 写入 + supersede 处理
   ├── lib/db.mjs           # pg pool
   └── index.mjs            # HTTP server + MCP transport
   ↓ PG SQL (openkos_service)
[阿里云 RDS PG17 · openkos.team_memory schema]
   ├── memories             # bi-temporal + maturity + 1024d vector
   ├── recall_log           # 跨 agent 流水
   └── promotion_log        # maturity 升降历史
```

---

## 文件结构

```
scripts/team-memory-service/
├── index.mjs                       # HTTP MCP server 主入口
├── lib/
│   ├── db.mjs                      # pg pool 单例
│   ├── recall.mjs                  # hybrid recall + RRF
│   ├── store.mjs                   # store + supersede + promote
│   └── auth.mjs                    # token 验证 + cache
├── sql/
│   └── 001-init.sql                # schema + 表 + 索引 + trigger
├── import-from-md.mjs              # team-memory/*.md → DB 一次性 import
├── backfill-embeddings.mjs         # 给 71 条历史 content 补 embedding
├── package.json                    # 依赖 + scripts
└── README.md                       # 本文件
```

---

## MCP 工具

| 工具 | 作用 |
|---|---|
| `team_recall_memory` | hybrid 召回（FTS + pgvector RRF 融合）；默认仅召 `proven`+`verified`，不带 draft 噪音 |
| `team_store_memory` | 存入 team-memory；新写入强制 `maturity=draft`；`type=decision` 自动 `requires_review=true` |
| `team_memory_stats` | 总数 / 按 type / 按 maturity / 近 24h recall 调用数 |
| `team_promote_maturity` | 升 maturity（`draft → verified` 由 owner 显式 promote，ADR-047 已退役自动 cron；`verified → proven` 必须 approver ack）⚠️ draft 可召回但 +4 偏移沉底 + ⚠️ 标记，写完仍必升 |
| `team_update_recall_final_count` | hook 后置过滤完回写真注入数（区分 raw 候选池 vs final injected） |

---

## 部署：dev 本地测试

```bash
cd src/team-memory-service
npm install
TM_DATABASE_URL='postgresql://user:password@localhost:5432/openkos' node index.mjs --transport=http --port=3000 --bind=127.0.0.1
```

健康检查：
```bash
curl http://127.0.0.1:3000/health
# {"ok":true,"server":"team-memory-service","version":"0.1.0","transport":"http","active_sessions":0,"uptime_sec":...}
```

---

## Agent 接入

各 agent 在 `.mcp.json` 加：

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "http",
      "url": "https://memory.OpenKOS.com/mcp",
      "headers": {
        "Authorization": "Bearer ${KOS_SERVICE_TOKEN}"
      }
    }
  }
}
```

> Phase 4 会提供 hook 模板（`team-prompt-recall.mjs` 等），团队 agent 直接 copy。

---

## 维护

### import 新数据
```bash
node import-from-md.mjs               # 跑真 import（hash 防重复）
node import-from-md.mjs --dry-run     # 预览
```

### backfill embeddings（一次性）
```bash
node backfill-embeddings.mjs          # 给 content_vector IS NULL 的全 backfill
node backfill-embeddings.mjs --limit 10  # 只跑 10 条
```

### schema 变更
- 新加列 / 索引：写 `sql/00N-<topic>.sql` + 在 ADR-025 §3 列出
- 重跑 `psql < sql/00N-...sql` 即可（DDL 全 IF NOT EXISTS）

---

## 监控指标

跑 `team_memory_stats` 看：
- `total` — 全库条数
- `by maturity` — proven / verified / draft 比例
- `recall calls (24h)` — 调用频次

详细召回流水从 `team_memory.recall_log` 表 query。

---

## 开发约束

1. **铁律 #10**：service 永不调 LLM。embedding 由 client（agent）端预算后传入
2. **铁律 #11**：境内可控 — DB / service 全在阿里云
3. **maturity 不可绕过**：client 强制 `draft`，升格走 `team_promote_maturity` 工具
4. **content_vector 1024d**：固定阿里百炼 v3 / OpenAI embedding-3-large 截断兼容
5. **Cache TTL**：token 验证 5min cache（agent_tokens 表轮换敏感时手动重启 service）

---

## 引用

- ADR-025: `docs/architecture/adr-025-team-memory-cloud-recall-service.md`
- 通用记忆实现 case study: `docs/recall-hooks-cc-case-study.md`
- memory-protocol v1.4: `docs/memory-protocol.md`
