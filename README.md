# OpenKOS

> **A publicly installable team memory system for AI agents.** Write your team's rules, decisions, and playbooks as
> markdown. OpenKOS builds a knowledge graph over them and does context-aware recall — so your
> agents stop reinventing decisions and inventing "facts" the team never agreed to.
> **Local-first engine plus a self-hosted shared service. Graceful degradation.**

[English](README.md) · [中文](README.zh-CN.md)

---

## The problem

AI agents are stateless, so teams paste a giant context file into every prompt. That has two failure
modes: you pay the token cost on **every** message, and the moment a decision isn't in that file, the
agent confidently makes one up. In a multi-agent team it's worse — each agent invents its *own*
version of a "team fact," and they quietly drift apart.

A pile of markdown files plus grep doesn't fix this. Grep finds a string; it doesn't tell you that
the rule you just found was **superseded last month**, or that changing it **affects eleven other
decisions**.

## What OpenKOS does

Five stages, each a plain Node script you can read in an afternoon:

```
write  →  route  →  graph  →  recall  →  inject
```

- **write** — an append with a dedup gate, so the same fact isn't stored five times
- **route** — entries land in `rules/` `playbooks/` `decisions/` by type, not by guess
- **graph** — a knowledge graph over the frontmatter: `related`, `supersedes`, `governs`
- **recall** — keyword + graph, returning each hit **with its graph neighbors**
- **inject** — a hook that surfaces the relevant memories before an agent acts

## See it in 60 seconds

The local engine needs no API key or database. The repo ships an example team memory set:

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

That `📎 1-hop` line is the whole point. A vanilla RAG lookup hands you a chunk of text and stops.
OpenKOS hands you the memory **plus what it's connected to in the team's knowledge graph**. Ask what
a change would ripple into:

```bash
node src/kg/queries/q-impact-radius.mjs every-rule-needs-falsifiable-contract
# → 11 nodes one hop away: 5 decisions, 3 playbooks, 3 rules — with their maturity levels
```

grep can't do that. A vector store can't do that. That's the difference.

## Rules that expire

Every rule carries a **falsifiable contract** in its frontmatter — a prediction, a way to check it,
and a deadline:

```yaml
maturity: verified
falsifiable_contract:
  predicted_metric: "direct pushes to main = 0 per month"
  verify_method: "git log --first-parent main | grep -c 'direct push'"
  verify_after: 2026-08-10
rollback_condition: "if the team ships faster with a lighter policy, retire this rule"
```

A rule isn't an opinion someone typed once and everyone obeys forever. It's a claim with an
expiry date. When `verify_after` passes and nobody re-verifies, the entry decays from `verified`
back toward `draft`, and agents treat it as untrusted until it's checked again. This is how the
team's memory stays honest instead of accumulating stale gospel.

## Bring your own data

The engine lives here; your team's memory lives wherever you point `KOS_DATA_ROOT`:

```bash
export KOS_DATA_ROOT=/path/to/your/repo   # must contain a team-memory/ directory
```

Optional, all off by default:

| Env var | What it turns on |
|---------|------------------|
| `EMBEDDING_API_KEY` | vector recall on top of keyword (any OpenAI-compatible endpoint) |
| `KOS_CODE_REPO` | index a code repo's files so rules trace to the code they govern |
| `KOS_ROSTER` | map contributors/reviewers to names for your team (defaults are generic) |

With none of them set, keyword recall over your markdown still works. Nothing crashes for the
absence of a key or a service — it just does less.

## Run the shared service

The shared service lives in `src/team-memory-service/` and provides PostgreSQL schema, bearer-token authentication, scope authorization, recall/store APIs, and an HTTP MCP endpoint. Install its dependencies, apply `sql/001-init.sql` plus the migrations in filename order, set `TM_DATABASE_URL`, `TM_MEMORY_AUTHZ_GRANTS`, and `KOS_SERVICE_TOKEN`, then run `npm start` from that directory. Bind it behind TLS when exposing it beyond localhost.

## Use it from an agent (MCP)

OpenKOS speaks the Model Context Protocol, so Claude Code, Cursor, and any MCP client can call it:

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

## Requirements

Node ≥ 20. Local mode has no database requirement; the shared service additionally requires PostgreSQL with pgvector. No build step.

## License

MIT
