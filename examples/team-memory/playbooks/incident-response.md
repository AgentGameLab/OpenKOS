---
name: incident-response
description: "Standard procedure for responding to production incidents that may involve agent actions."
type: playbook
topic: incident-management
scope: all-agents
maturity: verified
last_verified: 2026-09-18
proposed_by: Priya Singh
related:
  - no-direct-main-push
  - agent-output-needs-evidence
  - dispatching-subagents
---

# Incident response playbook

## 1. Declare

A human or supervisor agent posts in #incidents with the severity level (Sev1‑Sev3) and the affected service. The post triggers an automated recall: OpenKOS fetches the most recent incident post‑mortems and relevant rules (especially any falsifiable contracts that predict this type of failure).

## 2. Triage

The on‑call person (human) examines the agent‑provided recall snapshot. If an agent suggests a remediation, it must label the suggestion as `proposal` (not completion) and include the evidence that led to the suggestion.

## 3. Action

Any write‑oriented recovery step (rollback, hotfix, config change) must follow the `no-direct-main-push` rule unless the emergency bypass is invoked. If bypassed, the incident commander must create the audit trail within 60 minutes.

## 4. Close

The incident is not closed until:
- The root cause is recorded as a memory entry (type `finding`).
- Any rule whose predicted metric was violated (e.g., “zero direct main pushes”) is flagged for immediate re‑verification.
- The `weekly-memory-review` playbook is notified to accelerate review of any rules that may have contributed.

## 5. Aftermath

The post‑mortem document is committed to the incident log as a new entry. Agents that contributed to the response are evaluated: did their completion claims carry evidence? Did any agent invent a fact? Those observations feed back into prompts and rules.
