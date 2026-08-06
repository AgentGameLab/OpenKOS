---
name: adr-002-keyword-recall
description: "Initial recall strategy: use keyword matching over memory entry text and frontmatter."
type: decision
topic: recall-strategy
scope: all-agents
maturity: superseded
last_verified: 2026-04-15
proposed_by: Jasper Liu
falsifiable_contract:
  predicted_metric: "Recall‑at‑10 for a set of 20 hand‑crafted queries is at least 0.7."
  predicted_metric_2: "Total recall pipeline latency stays under 200ms for a 1000‑entry store."
  verify_method: "Run the benchmark suite `./benchmark/recall-bench.sh` with the standard query set."
  verify_after: 2026-07-15
  rollback_condition: "If recall@10 drops below 0.5 or latency exceeds 500ms on the benchmark, we will replace the keyword engine with a different approach within one sprint."
related:
  - adr-001-file-based-memory
  - recall-latency-benchmark
  - every-rule-needs-falsifiable-contract
---

# ADR‑002: Start with keyword recall

## Context

With memory entries stored as markdown, we needed a retrieval mechanism. The simplest approach was token‑based keyword matching, using BM25 over the combined description and body text. More sophisticated vector search was discussed but would require an embedding pipeline and index maintenance.

## Decision

We will implement keyword‑based recall first. The recall module tokenizes input queries, builds a BM25 index over all non‑draft entries, and returns the top‑k matches.

## Status: superseded by ADR‑003

After running the keyword‑only approach for two months, we captured concrete latency and recall‑quality numbers. While latency was excellent (median 80ms on 500 entries), recall‑at‑10 for semantic‑similar queries was only 0.52. ADR‑003 (hybrid recall) replaced this decision. This ADR is retained as a record of the baseline and its contract outcome.
