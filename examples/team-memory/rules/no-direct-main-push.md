---
name: no-direct-main-push
description: "Ban direct pushes to the main branch; all changes must arrive via pull request with review and CI pass."
type: rule
topic: git-workflow
scope: all-agents
maturity: proven
last_verified: 2026-08-22
proposed_by: Elena Vasquez
falsifiable_contract:
  predicted_metric: "Zero direct commits on origin/main (excluding merge commits from PRs) in any rolling 30-day window."
  predicted_metric_2: "Mean time from branch creation to merge ≤ 72 hours."
  verify_method: "Run `git log origin/main --oneline --no-merges` for direct commits. For latency, compute merge-parent timestamps and branch point timestamps via `git merge-base` and subtract average."
  verify_after: 2026-10-22
  rollback_condition: "If any direct (non-merge) commit reaches main, or if mean merge latency exceeds 120 hours, this rule is retired and the branch protection policy is re-evaluated."
related:
  - every-rule-needs-falsifiable-contract
  - onboarding-new-agent
  - incident-response
---

# Rule: no direct main push

## What happened

In March 2025, a team member force-pushed a broken commit to `main` that bypassed CI checks. The deployment froze for 47 minutes, and two customers reported timeouts. After the incident, we agreed that direct pushes—however convenient—are not acceptable when anyone else depends on the branch.

## The rule

All changes to the `main` branch must go through a pull request that:

1. passes the full CI suite,
2. receives approval from at least one other human (or verified agent acting as reviewer),
3. includes an automated merge commit — never a fast-forward.

No agent or human is allowed to `git push origin main` except via the merge button in the pull request flow. The branch protection setting enforces this mechanically.

## Boundaries

Rule applies to any repository marked as `shared-core` in the team registry. For a solo prototype repo that no other agent reads, direct pushes are tolerated — but only if the repo does not feed into the recall pipeline.

## Counter‑example

A release‑blocker hotfix on a Friday evening: the on‑call person can bypass via the `emergency-push` procedure if they post a brief audit trail in the incident channel. That exception must itself be reviewed within 24 hours and re‑merged through a proper PR. Without the audit trail, the bypass is treated as a direct push violation.

We track this with a script: `./scripts/check-direct-pushes.sh`. The verify method in the falsifiable contract runs exactly that script over a 30‑day window, so nobody has to argue about the numbers.
