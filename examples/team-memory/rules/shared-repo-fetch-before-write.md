---
name: shared-repo-fetch-before-write
description: "Before writing to any repository shared with other agents or humans, an agent must fetch the latest remote state within the preceding 5 minutes."
type: rule
topic: git-workflow
scope: all-agents
maturity: draft
last_verified: 2026-08-30
proposed_by: Derek Mwangi
falsifiable_contract:
  predicted_metric: "Merge conflicts caused by stale local branches drop by 80% within 60 days of enforcement, compared to the 90‑day baseline before the rule."
  predicted_metric_2: "The number of force‑push incidents in shared repos stays at zero for the same period."
  verify_method: "Count merge conflicts from git reflogs and compare with pre‑rule records. Force‑push count is tracked via pre‑receive hook logs."
  verify_after: 2026-10-30
  rollback_condition: "If the conflict rate decreases by less than 50% or if agents consistently miss the 5‑minute window (as measured by fetch‑time audit), the rule is retired because it adds overhead without enough safety gain."
related:
  - no-direct-main-push
  - every-rule-needs-falsifiable-contract
  - onboarding-new-agent
---

# Rule: shared repo — fetch before write

## Trigger

In June 2025, two agents independently worked on the same configuration file in a shared infrastructure repository. Neither fetched before pushing. The second agent’s force‑push overwrote the first agent’s valid change, rolling back a production firewall rule. Monitoring gap lasted 4 hours.

## The rule

Before any write operation (`git push`, `git commit` intended for immediate push, or file update via an API that updates the shared repo), the agent must execute an explicit `git fetch origin` and ensure the local branch is up‑to‑date. The fetch must have occurred within the previous 5 minutes (we check via agent‑logged timestamps).

For non‑git shared stores (e.g., S3‑backed artifact registries), the agent must list the target key and confirm the most recent modification timestamp is no older than 5 minutes before acting.

## Implementation

We install a pre‑push hook in all `shared-core` repos that refuses any push unless the local branch tip is known to the remote. The hook records the push attempt, fetch timestamp, and agent ID.

## Counter‑example

A single‑user experimental repo that no other agent shares is exempt. The rule applies only to repos tagged `shared-core` in the team registry. Also, purely read‑only operations (clone, pull) are exempt — reads may be stale, but they cannot corrupt others’ work.
