---
name: adr-003-hybrid-recall
description: "Add vector similarity recall alongside keyword recall and combine results with fusion scoring."
type: decision
topic: recall-strategy
scope: all-agents
maturity: verified
last_verified: 2026-06-20
proposed_by: Noa Kurosawa
falsifiable_contract:
  predicted_metric: "Recall‑at‑10 on the standard 20‑query benchmark rises to ≥ 0.85."
  predicted_metric_2: "P95 latency of the combined recall pipeline stays ≤ 500ms at 2000 entries."
  verify_method: "Run `./benchmark/recall-bench.sh` with the hybrid flag; latency measured via OpenTelemetry traces."
  verify_after: 2026-09-20
  rollback_condition: "If recall@10 stays below 0.75 after two tuning rounds, or if P95 latency exceeds 750ms and cannot be brought down within a sprint, we revert to keyword‑only and revisit embedding model choice."
related:
  - adr-001-file-based-memory
  - adr-004-dedup-threshold
  - recall-latency-benchmark
  - every-rule-needs-falsifiable-contract
supersedes: adr-002-keyword-recall
---

# ADR‑003: Hybrid recall

## Motivation

ADR‑002’s keyword‑only recall failed on queries that did not share exact tokens with the target memory. For example, “blob store” would not retrieve an entry titled “S3 artifact registry” unless the body contained the exact phrase. We needed a second signal that captures semantic similarity.

## Decision

We add an embedding‑based recall path. On every write, the engine generates a dense vector from the entry’s concatenated description+body using a lightweight sentence‑transformer model (`all-MiniLM-L6-v2`). At query time, we compute the query vector and retrieve the top‑k via cosine similarity. The results are merged with the BM25 results using reciprocal rank fusion (k=60). The fusion step is tunable, but the exact weights are driven by the dedup gate (see ADR‑004).

## Consequences

- The recall pipeline now runs two index scans per query. P95 latency on 2000 entries is 340ms (see `recall-latency-benchmark` finding), well within our 500ms target.
- Memory footprint increased by ~12MB for vector storage.
- **This decision supersedes ADR‑002.** The keyword‑only path remains as a component, but the system is now `hybrid` by default.

The contract passed: in June 2025, recall@10 hit 0.89 and P95 latency was 410ms.
