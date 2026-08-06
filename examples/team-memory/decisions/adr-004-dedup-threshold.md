---
name: adr-004-dedup-threshold
description: "Setting the duplication gate cosine threshold to 0.85 based on measured false‑kill rates."
type: decision
topic: recall-quality
scope: all-agents
maturity: draft
last_verified: 2026-07-05
proposed_by: Derek Mwangi
falsifiable_contract:
  predicted_metric: "Duplicate entries injected into the agent context drop by 90% compared to the pre‑gate period (14‑day window before vs after)."
  predicted_metric_2: "False‑kill rate (correct entries marked as duplicates and excluded) remains ≤ 5%."
  verify_method: "Run the dedup‑audit script `./audit/dedup-stats.sh` which compares automatically flagged duplicates against human‑labelled gold set of 200 pairs; track injection counts via agent‑context snapshots."
  verify_after: 2026-10-05
  rollback_condition: "If false‑kill exceeds 8%, lower the threshold to 0.80 and re‑measure. If duplication rate does not decrease by at least 80%, the gate is removed."
related:
  - adr-003-hybrid-recall
  - recall-latency-benchmark
  - every-rule-needs-falsifiable-contract
---

# ADR‑004: Dedup threshold selection

## The problem

When two entries are nearly identical (e.g., a draft rule and its verified successor), the recall pipeline may return both, cluttering the agent’s context. We introduced a cosine‑similarity gate that drops the lower‑scored entry if the pair similarity exceeds a threshold.

## How we picked 0.85

We ran an experiment in June 2025 on a snapshot of 500 OpenKOS entries. For each possible threshold from 0.70 to 0.95 in 0.05 steps, we computed:

| Threshold | False‑kill rate (pairs wrongly removed) | True duplicates caught | Context slot usage |
|-----------|----------------------------------------|------------------------|---------------------|
| 0.70      | 0.3%                                   | 42%                    | still bloated       |
| 0.75      | 0.6%                                   | 67%                    |                     |
| 0.80      | 1.2%                                   | 85%                    |                     |
| 0.85      | 3.1%                                   | 94%                    | tight               |
| 0.90      | 7.4%                                   | 98%                    |                     |
| 0.95      | 14.9%                                  | 99%                    | over‑aggressive     |

At 0.85, the false‑kill rate was 3.1% (within our 5% safety margin) and 94% of true duplicates were removed. Moving to 0.90 would kill 7.4% of good entries — unacceptable given that a missing memory could cause agent hallucination.

## Decision

We set the dedup gate threshold to 0.85. This threshold is itself a candidate for a future rule with its own contract; for now, it is baked into the recall module but must be re‑verified quarterly.
