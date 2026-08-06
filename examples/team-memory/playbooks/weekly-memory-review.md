---
name: weekly-memory-review
description: "A recurring playbook for reviewing OpenKOS memory entries, ensuring falsifiable contracts are verified and maturity does not decay."
type: playbook
topic: memory-maintenance
scope: all-agents
maturity: verified
last_verified: 2026-09-25
proposed_by: Jasper Liu
related:
  - every-rule-needs-falsifiable-contract
  - agent-output-needs-evidence
  - no-direct-main-push
  - adr-001-file-based-memory
  - recall-latency-benchmark
---

# Weekly memory review

## Purpose

If nobody touches a rule, it rots. The falsifiable contract requires that verified rules be re‑tested periodically. This playbook ensures that happens before agents start ignoring outdated checks.

## The maturity decay mechanism

When a rule is `verified`, its `verify_after` date is a promise: someone will run the verification script and update `last_verified` and `verify_after` to the next window. If the date passes and no verification event is recorded, the system automatically demotes the rule’s maturity from `verified` to `draft`. Draft rules are excluded from the recall pipeline’s top tier and carry a `stale‑draft` warning in the agent context.

This prevents the scenario where a rule says “zero direct pushes” but nobody checked for three months, yet agents treat it as a reliable fact.

## Procedure (every Friday)

1. Run `npx openkos verify --due`. This lists all rules whose `verify_after` is ≤ today.
2. For each listed rule, execute its `verify_method`. If the method is a script, run it and capture the output.
3. If the prediction holds, update `last_verified` to today and set `verify_after` to the next checkpoint (typically +30/90 days depending on rule cadence). If it fails, flag the rule as `disproved` and initiate a discussion in the #openkos channel.
4. Review any decisions with `falsifiable_contract` that are past their `verify_after`. Same treatment.
5. Check for orphaned entries: rules that reference other entries that have been superseded or deleted. File a cleanup PR.
6. Spot‑check three random completion claims from the past week to ensure they comply with the `agent-output-needs-evidence` rule. If violations are found, adjust agent prompts.

The review session should produce a commit to the memory repo summarizing what was verified and what decayed. That commit itself is evidence — it closes the verification loop.
