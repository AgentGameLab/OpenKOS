---
name: agent-output-needs-evidence
description: "When an agent reports a task as completed, the output message must include a verifiable evidence trail."
type: rule
topic: agent-communication
scope: all-agents
maturity: verified
last_verified: 2026-02-01
proposed_by: Noa Kurosawa
falsifiable_contract:
  predicted_metric: "> 90% of completion posts in the #agent-outputs channel contain at least one artifact (link, log, screenshot, diff, or hash) within 90 days."
  predicted_metric_2: "The median time to verify a completion claim (measured from claim post to human close) drops below 3 minutes."
  verify_method: "Sampling: pull 50 random completion messages from the last 14 days, check for presence of artifacts. Time to verify is tracked in the ticketing system; compute median."
  verify_after: 2026-12-10
  rollback_condition: "If after 90 days the artifact rate stays below 65% or median verify time remains above 10 minutes, the rule is judged too burdensome and replaced with a lighter signal‑based approach."
related:
  - every-rule-needs-falsifiable-contract
  - dispatching-subagents
  - why-agents-hallucinate-team-facts
---

# Rule: agent output needs evidence

## The problem

In early 2025, an agent reported “deployment rolled back — incident resolved.” Ten minutes later, a customer reported the same error. The agent had misinterpreted a log line; no rollback had actually occurred. Because the message was a bare claim, we wasted 20 minutes chasing a non‑fact.

The same pattern appeared repeatedly: agents would claim “task completed” but the human (or supervisor agent) had no way to quickly verify without re‑running the whole job.

## The rule

Every completion claim from an agent must include **at least one piece of verifiable, external evidence**. Examples:

- A link to the CI run with a green build
- A diff of the changed files
- A truncated log excerpt showing the success line
- An S3 object key where the output artifact is stored
- A hash of the output and a pointer to the verifier script

The evidence must be something that can be checked in under 2 minutes without re‑executing the original task.

## Distinction between a proposal and a completion

A proposal (or triage message) may omit evidence; the agent is merely suggesting a next step. A **completion claim** is a statement of fact: “X is now done.” That requires a receipt.

We maintain a bot that scans the #agent‑outputs channel and flags claims without evidence. Flagged claims get a `needs‑evidence` label and are excluded from downstream decision loops.

## Counter‑example

If the task was “fetch the current price of EC2 m7i.large in us‑east‑1” and the agent returns the price and a citation of the AWS CLI command used, that **is** evidence. A restatement of the answer is not. The evidence is the specific command output or the tool invocation record.
