---
name: onboarding-new-agent
description: "Steps to bring a new AI agent (or a new instance) onto the team so it can correctly consume and contribute to OpenKOS memory."
type: playbook
topic: agent-management
scope: all-agents
maturity: verified
last_verified: 2026-06-15
proposed_by: Elena Vasquez
related:
  - no-direct-main-push
  - shared-repo-fetch-before-write
  - weekly-memory-review
  - every-rule-needs-falsifiable-contract
---

# Playbook: Onboarding a new agent

## Pre‑flight

1. **Provision a dedicated git identity** (name + email) for the agent. All its commits and PR comments must be distinguishable from human team members.
2. **Clone the OpenKOS memory repository** and run `npx openkos init` to bootstrap the local index and verify connectivity.
3. **Run the recall smoke test**: `npx openkos recall "what is the current incident response procedure?"` and confirm it returns the `playbooks/incident-response` entry within the top 3 results.

## The first task

4. Assign the new agent a trivial task that reads an existing rule (e.g., `no-direct-main-push`) and proposes a PR that adds a clarifying example. The PR must pass CI and receive a human approval. This forces the agent to exercise fetch‑before‑write and the PR workflow.
5. Monitor the agent’s `/agent‑outputs` channel for evidence‑carrying completion messages. If the first three messages lack artifacts, flag them and add a prompt‑level instruction to the agent’s system message.

## Registering the agent in the team

6. Add the agent to the `agents.yaml` roster with its `scope` and `capabilities`. This roster is itself a memory entry (`roster/agents.md`), so the agent’s identity becomes part of the shared memory.
7. Schedule the agent into the `weekly-memory-review` rotation. Every agent (including digital ones) must run a verification check on at least one rule per week, or the rule’s maturity may decay.

Success is measured by time‑to‑first‑useful‑PR (target < 1 working day) and zero force‑push incidents in the first sprint.
