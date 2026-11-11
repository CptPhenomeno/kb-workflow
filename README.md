# kb-workflow

A [pi](https://github.com/badlogic/pi-mono) extension that drives the
[`kb`](https://github.com/CptPhenomeno/kb) kanban board end to end with subagents.

## Commands

| Command | What it does |
| ------- | ------------ |
| `/kb-plan [idea]` | Interviews you (via the `ask_user` tool) until the specification is clear, asks for confirmation, then writes a new versioned section (`## vN — <date>`, appended at the end) to `SPEC.md` at the project root. Finally it runs the **kb-planner** subagent, which runs `kb init` if needed, writes `plan.yaml` at the project root, validates it with `kb import plan.yaml --dry-run` and imports it (`--update` when the refs already exist). |
| `/kb-dev` | Picks the next open, unblocked **story** on the board and works it to completion: for each task (in DAG order, `kb next --parent <story>` already respects `blocks`) it spawns a **kb-developer** subagent (one automatic retry on failure), then any item in `review` is checked by a **kb-reviewer** subagent (re-runs the test suite, inspects the diff, moves to `done` or sends back to `todo`). One story per invocation; re-running `/kb-dev` continues with the next story. |

## Tools (callable by the LLM)

| Tool | What it does |
| ---- | ------------ |
| `ask_user(question, options?, multiple?)` | Asks the user through the TUI: free-text input, single-choice select (with a "type a custom answer" escape hatch) or a multi-select checkbox list. |
| `kb_agent(agent, task)` | Runs `kb-planner` / `kb-developer` / `kb-reviewer` in an isolated `pi --mode json -p --no-session` process with its own system prompt (`agents/<name>.md`) plus the output of `kb guide`. The subagent identifies on the board as `agent-plan` / `agent-dev` / `agent-review`. |

## Subagents

| Agent | Role | Board actor |
| ----- | ---- | ----------- |
| `agents/kb-planner.md` | SPEC.md → `plan.yaml` → `kb import` | `agent-plan` |
| `agents/kb-developer.md` | Implements one item with the TDD loop from `kb guide` | `agent-dev-<ID>` |
| `agents/kb-reviewer.md` | Re-runs tests, reviews the diff, `done` or back to `todo` | `agent-review-<ID>` |

## Model configuration

Models for the subagents are resolved from (later wins):

1. `<agentDir>/kb-workflow.json` — e.g. `~/.pi/agent/kb-workflow.json` (global)
2. `<project>/.pi/kb-workflow.json` — project-local override

```json
{
	"models": {
		"planner": "anthropic/claude-sonnet-4-5",
		"developer": "anthropic/claude-haiku-4-5",
		"reviewer": "anthropic/claude-sonnet-4-5"
	}
}
```

See `kb-workflow.example.json`. A role left unset inherits the model active in
the dispatching pi session.

## Install

Symlink or copy this directory into pi's global extension directory so it is
auto-discovered:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/kb-workflow
# then /reload inside pi
```

Or load it ad hoc for testing:

```sh
pi -e /path/to/kb-workflow/index.ts
```

## Requirements

- `kb` on the `PATH` (`go install github.com/CptPhenomeno/kb/cmd/kb@latest`)
- a project where you want a kanban board (`.kanban/` is created by the planner)
