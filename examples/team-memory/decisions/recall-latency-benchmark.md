---
name: recall-latency-benchmark
description: "Measured recall latency for keyword‑only and hybrid engines at various store sizes."
type: decision
topic: performance
scope: all-agents
maturity: verified
last_verified: 2026-09-12
proposed_by: Noa Kurosawa
related:
  - adr-002-keyword-recall
  - adr-003-hybrid-recall
  - adr-004-dedup-threshold
---

# Recall latency benchmark

We measured end‑to‑end recall latency (query arrival to final ranked list) on an AWS c6i.xlarge instance, using a test corpus of real OpenKOS entries scaled to different sizes by augmentation.

| Engine        | Entries | P50 (ms) | P95 (ms) | P99 (ms) | Notes |
|---------------|---------|----------|----------|----------|-------|
| Keyword‑only  | 100     | 22       | 38       | 42       | BM25 over description+body |
| Keyword‑only  | 500     | 55       | 92       | 110      |         |
| Keyword‑only  | 2000    | 180      | 310      | 380      |         |
| Hybrid        | 100     | 45       | 72       | 85       | includes embedding generation (sentence‑transformer) |
| Hybrid        | 500     | 110      | 198      | 240      |         |
| Hybrid        | 2000    | 280      | 340      | 420      | dedup gate adds ~8ms at this scale |
| Hybrid + dedup| 2000    | 290      | 350      | 435      |         |

All times are median of 1000 queries per configuration. The hybrid engine adds ~50% latency over keyword‑only, but both stay well under the 500ms P95 contract for 2000 entries. At 2000 entries the dedup gate’s overhead is negligible.

We re‑run this benchmark before every release. The numbers above are from the 2025‑09‑10 snapshot.
