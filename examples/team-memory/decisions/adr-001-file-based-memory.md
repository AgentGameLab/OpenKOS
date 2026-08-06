---
name: adr-001-file-based-memory
description: "Decision to store team memory as markdown files with frontmatter rather than in a database."
type: decision
topic: architecture
scope: all-agents
maturity: verified
last_verified: 2026-02-10
proposed_by: Priya Singh
falsifiable_contract:
  predicted_metric: "Median time to add a new memory entry is less than 5 minutes for any team member."
  predicted_metric_2: "Zero instances of data corruption or loss attributable to file storage format over the first 12 months."
  verify_method: "Track time-to-add via team journal entries (start/stop timestamps on PR creation). Data‑loss incidents are tracked in the incident log."
  verify_after: 2026-08-10
  rollback_condition: "If time-to-add exceeds 10 minutes median for three consecutive months, or if two separate data‑loss events occur, we will migrate to a document database (MongoDB) and republish all entries with the same schema."
related:
  - every-rule-needs-falsifiable-contract
  - adr-003-hybrid-recall
  - recall-latency-benchmark
---

# ADR‑001: File‑based memory

## Context

In January 2025, the Core Infra team started building OpenKOS to give agents a shared long‑term memory. We could store the memory entries in a database, but the team works heavily with git and markdown already. The question: markdown files in a git repo, or a purpose‑built store?

## Decision

We will store every memory entry as a standalone markdown file with structured frontmatter. The files live in a git repository, enabling normal branching, review, and history.

## Rationale

- Git provides free versioning, blame, and audit.
- Team members can edit memories with the same tools they use for code.
- The falsifiable contract concept is easy to embed as YAML.
- No migration scripts, no schema changes beyond frontmatter rules.
- Search and graph building can be done by reading files from disk (eventually by a sidecar that keeps an index in memory).

## Consequences

OpenKOS’s core engine reads every `.md` file at startup and builds a knowledge graph. This adds startup time that scales with the number of entries. At 500‑entry scale, startup is ~0.5s. We accept this until it becomes a bottleneck (see recall‑latency findings).

The decision is verified: after 6 months, the median add‑time was 3.2 minutes and zero file‑format data losses occurred. The contract succeeded, so the decision stands.
