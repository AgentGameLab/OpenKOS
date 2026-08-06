---
name: dispatching-subagents
description: "Criteria for when a primary agent should delegate work to a subagent and how to ensure the subagent obeys team memory rules."
type: playbook
topic: agent-orchestration
scope: all-agents
maturity: draft
last_verified: 2026-08-05
proposed_by: Derek Mwangi
related:
  - agent-output-needs-evidence
  - onboarding-new-agent
  - every-rule-needs-falsifiable-contract
---

# Dispatching subagents

## When to dispatch

A primary agent should spawn a subagent (a more limited instance, possibly with different tool access) when:

- The task is a **side effect** that does not require the primary’s full context (e.g., “fetch the latest version of library X from the registry and update a single file”).
- The task is **sandbox‑safe**: it reads only, or writes to a temporary branch that the primary will review.
- The task would otherwise block the main loop, and parallel execution reduces wall‑clock time.

## Pre‑dispatch checks

The primary must inject the relevant memory entries into the subagent’s context **before** dispatching. Use the recall query: `npx openkos recall "<task description>" --context-limit 3` and pass the output as the subagent’s prefixed system note.

The primary must also verify that the subagent’s identity (git author, channel) is correctly configured — the same onboarding checks apply, even if the subagent is ephemeral.

## The subagent’s output requirement

The subagent is bound by `agent-output-needs-evidence`. Its completion report to the primary must include the same artifact‑level evidence. If evidence is missing, the primary must not incorporate the result into its own output; it must re‑dispatch or re‑run the check.

## Counter‑example

Do **not** dispatch a subagent to modify a shared configuration file directly on the main branch. That would violate `no-direct-main-push` unless the subagent goes through a PR. The primary must create a branch, have the subagent commit to that branch, and then open a PR — the primary retains review responsibility.
