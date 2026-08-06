---
name: every-rule-needs-falsifiable-contract
description: "A rule stored in OpenKOS must carry a falsifiable contract with measurable predictions, a verification method, a deadline, and a rollback condition."
type: rule
topic: meta-process
scope: all-agents
maturity: proven
last_verified: 2026-09-01
proposed_by: Jasper Liu
falsifiable_contract:
  predicted_metric: "100% of active rules (non‑superseded, non‑draft) in the repository have a complete falsifiable_contract block within 60 days of this meta‑rule’s creation."
  predicted_metric_2: "Zero rules are left with ‘verified’ maturity and a verify_after date more than 14 days past without a verification event."
  verify_method: "Run `./scripts/audit-contracts.sh` which scans all rule entries for presence of the five required fields and checks maturity/date consistency. A dashboard is available at `/dash/contracts`."
  verify_after: 2026-11-01
  rollback_condition: "If, after 90 days, more than 5% of active rules lack a contract or if any verified rule is found stale (verify_after passed with no re‑verification) and no corrective action is taken, this meta‑rule is considered disproved and must be replaced with a less strict governance model."
related:
  - no-direct-main-push
  - agent-output-needs-evidence
  - adr-001-file-based-memory
  - weekly-memory-review
  - why-agents-hallucinate-team-facts
---

# Meta‑rule: every rule needs a falsifiable contract

## Why this matters

OpenKOS is a memory engine for distributed AI agents. In a shared knowledge graph, it’s too easy to leave a rule like “code reviews are required” and have it treated as gospel forever. Over time, nobody remembers why the rule exists and whether it still helps.

The falsifiable contract turns every rule into a testable claim. It forces the team (and the agents) to say in advance: *what would prove this rule wrong?* If nobody can answer that, the rule is an unexamined habit — and agents should treat it as untrusted draft until it is tested.

## The contract fields

Every rule in OpenKOS must include in its frontmatter:

| Field | Purpose |
|-------|---------|
| `predicted_metric_1` | A measurable prediction with a number. Example: “direct pushes to main = 0 per month.” |
| `predicted_metric_2` | A second, ideally orthogonal, prediction. |
| `verify_method` | A concrete, repeatable way to check. Must be runnable or inspectable (a script, a dashboard query, a log grep). |
| `verify_after` | The date after which the prediction is due to be checked. |
| `rollback_condition` | The exact condition under which the rule is considered wrong and must be retired or rewritten. |

Rules without a contract stay in `maturity: draft` forever. The `weekly-memory-review` playbook enforces that any verified rule whose `verify_after` date passes without re‑verification automatically drops back to `draft` — so an agent won’t rely on it.

## Self‑reference

We eat our own dog food. This meta‑rule itself carries a contract. If the contract fails, the meta‑rule is disproved and we must admit that mandatory contracts don’t work for our team. That would be a valid outcome — it closes the loop.

## Counter‑example

We do not require a contract for decisions that are purely historical (like an ADR recording “we chose X on date Y”). Those entries are findings, not rules. But if a decision contains a standing operating constraint (e.g., “dedup threshold must be 0.85”), that constraint must be captured as a **rule** with its own contract.
