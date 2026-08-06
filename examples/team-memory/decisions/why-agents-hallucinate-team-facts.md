---
name: why-agents-hallucinate-team-facts
description: "Root‑cause analysis of why AI agents invent team rules, decisions, and context when they lack a shared memory."
type: decision
topic: agent-reliability
scope: all-agents
maturity: verified
last_verified: 2026-03-05
proposed_by: Priya Singh
related:
  - every-rule-needs-falsifiable-contract
  - agent-output-needs-evidence
  - weekly-memory-review
---

# Why agents hallucinate team facts

## Observed pattern

Between January and March 2025, we tracked 14 instances where an AI agent (code‑review bot, release manager, incident assistant) asserted a “team policy” that either didn’t exist or had been retired. Examples:

- Agent blocked a merge because “monorepo policy requires a linear history for all services” — but that rule had been abandoned 6 months prior.
- Agent told a new engineer that “the on‑call rotation starts at 09:00 UTC” — correct for one timezone but not others; the actual rule had a table that the agent never saw.

## Root cause

The agents had no persistent, queryable memory of team‑specific rules. Each invocation started from a blank slate (apart from a generic prompt). When the agent needed a team rule, it fell back to its training data — which contains general best practices, not **our** team’s actual decisions. The result is a confident invention of plausible but wrong facts.

## How OpenKOS addresses this

By putting rules, decisions, and playbooks into a recallable graph, we give the agent a concrete answer to the question “what does this team actually do?” When the agent queries the memory engine and the recall returns `no-direct-main-push` with a falsifiable contract that was verified three days ago, the agent can cite that entry instead of guessing. The falsifiable contract provides additional trust: the agent sees that the claim was recently tested, so it isn’t just an unverified string.

## Key design implications

- Recall must be fast (see latency benchmark) so the agent doesn’t skip it.
- Memory entries must be kept current (see weekly review) or the agent will start ignoring stale ones.
- Every claim an agent makes about team facts must carry an evidence citation from memory (see agent‑output‑needs‑evidence rule), closing the loop.

This finding is the problem statement that justifies the existence of OpenKOS and all its mechanisms.