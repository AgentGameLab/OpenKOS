# OpenKOS

> **为 AI 智能体打造、可公开安装的团队记忆系统。** 将团队的规则、决策和操作手册写成 markdown。
> OpenKOS 会在它们之上构建知识图谱，并进行上下文感知的召回——这样你的智能体就不会
> 再去重复发明决策，也不会再编造团队从未认可过的“事实”。
> **本地优先引擎 + 可自托管共享服务。优雅降级。**

[English](README.md) · [中文](README.zh-CN.md)

---

## 问题

AI 智能体是无状态的，于是团队把一份庞大的上下文文件粘贴到每次提示里。这会带来两种失败
模式：你为**每条**消息支付 token 成本，而且一旦某个决策不在该文件中，智能体就会自信地
胡编一个。在多智能体团队中更糟——每个智能体都会编造自己的“团队事实”，然后它们悄悄地
产生分歧。

一堆 Markdown 文件外加 grep 也无法解决这个问题。grep 能找到字符串，但它不会告诉你，
你刚刚找到的规则在**上个月已被替代**，或者修改它会**影响到另外十一个决策**。

## OpenKOS 做什么

五个阶段，每个都是你一个下午就能读完的普通 Node 脚本：

```
write  →  route  →  graph  →  recall  →  inject
```

- **write** — 写入：带去重的追加，同一事实不会被存五次
- **route** — 路由：条目按类型归入 `rules/` `playbooks/` `decisions/`，而非靠猜测
- **graph** — 图谱：基于 frontmatter 构建知识图谱：`related`、`supersedes`、`governs`
- **recall** — 召回：关键词 + 图谱，返回每条命中条目**及其图谱邻居**
- **inject** — 注入：一个钩子，在智能体行动前浮现相关记忆

## 60 秒上手

本地引擎不需要 API 密钥或数据库。仓库附带了一份示例团队记忆集：

```bash
git clone https://github.com/AgentGameLab/OpenKOS
cd OpenKOS && npm install

export KOS_DATA_ROOT=./examples
node src/kg/knowledge-graph-gen.mjs          # build the graph: 14 nodes, 67 edges
node src/kos/kos-recall.mjs --query "how do we stop agents inventing facts"
```

```
[1] decisions/why-agents-hallucinate-team-facts.md          (score: 2.7)
    type: decision | maturity: verified
    📎 1-hop: related→rules/every-rule-needs-falsifiable-contract.md,
              related→rules/agent-output-needs-evidence.md
```

那条 `📎 1-hop` 行正是关键所在。普通的 RAG 查找给你一段文本就完了。OpenKOS 则返回记忆
**以及它在团队知识图谱中的关联**。问问某个变更会波及什么：

```bash
node src/kg/queries/q-impact-radius.mjs every-rule-needs-falsifiable-contract
# → 11 nodes one hop away: 5 decisions, 3 playbooks, 3 rules — with their maturity levels
```

grep 做不到。向量存储也做不到。这就是区别。

## 会过期的规则

每条规则在 frontmatter 中都带有一个**可证伪合约**——包含一个预测、一种检验方式和截止日期：

```yaml
maturity: verified
falsifiable_contract:
  predicted_metric: "direct pushes to main = 0 per month"
  verify_method: "git log --first-parent main | grep -c 'direct push'"
  verify_after: 2026-08-10
rollback_condition: "if the team ships faster with a lighter policy, retire this rule"
```

规则不是某人打过一次字、大家就得永远遵守的意见。它是一条带有效期的断言。当
`verify_after` 到期且无人重新验证时，条目会从 `verified` 降级回 `draft`，智能体会
将其视为不可信，直到再次核验。团队的记忆就是这样保持诚实，而不是堆积陈腐教条。

## 自带数据

引擎在此；你团队的记忆位于你把 `KOS_DATA_ROOT` 指向的地方：

```bash
export KOS_DATA_ROOT=/path/to/your/repo   # must contain a team-memory/ directory
```

可选，均默认关闭：

| 环境变量 | 作用 |
|---------|------------------|
| `EMBEDDING_API_KEY` | 在关键词之上启用向量召回（兼容 OpenAI 的任意接口） |
| `KOS_CODE_REPO` | 为代码仓库的文件建立索引，让规则可追溯至所管控的代码 |
| `KOS_ROSTER` | 将贡献者/评审者映射为团队中的名字（默认均为通用名） |

即使不设置任何一个，对 markdown 的关键词召回依然有效。缺少密钥或服务不会导致崩溃——
只是功能会少一些。

## 运行共享服务

共享服务位于 `src/team-memory-service/`，提供 PostgreSQL schema、Bearer token 认证、scope 授权、召回/写入 API 与 HTTP MCP endpoint。安装该目录依赖，依文件名顺序应用 `sql/001-init.sql` 和 `migrations/`，设置 `TM_DATABASE_URL`、`TM_MEMORY_AUTHZ_GRANTS`、`KOS_SERVICE_TOKEN`，再在该目录执行 `npm start`。服务暴露到 localhost 之外时必须置于 TLS 之后。

## 在智能体中使用（MCP）

OpenKOS 遵循 Model Context Protocol，因此 Claude Code、Cursor 以及任何 MCP 客户端都可以
调用它：

```json
{
  "mcpServers": {
    "openkos": {
      "command": "node",
      "args": ["/path/to/OpenKOS/src/kos/mcp-server.mjs"],
      "env": { "KOS_DATA_ROOT": "/path/to/your/repo" }
    }
  }
}
```

## 环境要求

Node ≥ 20。本地模式不要求数据库；共享服务另需带 pgvector 的 PostgreSQL。不需要构建步骤。

## 许可证

MIT