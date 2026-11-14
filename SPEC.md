# kb-workflow — Specification

This document specifies the `kb-workflow` pi extension: the `/kb-plan` and `/kb-dev` commands and the kb-planner / kb-developer / kb-reviewer / kb-qa subagents that drive the `kb` kanban board end to end. Each section is one version of the extension, **ordered newest first** (keepachangelog style): a new version is inserted at the top; existing sections are never rewritten.

## v0.2.1 — 2026-11-14

Changes vs v0.2.0: **subagent visibility**. The per-role resolution (FR-20/FR-21) is now surfaced instead of being silent: the TUI shows which model and thinking level every subagent round actually runs with (kb_agent tool streaming + custom rendering, /kb-dev report lines, message-mode kickoff), and a **usage ledger** persisted across runs records every round's token and euro spend, surfaced as per-run totals in the /kb-dev report and as cumulative totals via the new `/kb-cost` command. Covers the backlog items KB-40 (tui-model-display) and KB-41 (usage-ledger).

Amended 2026-11-14 after the review of the usage-ledger story (AC-34..37 verified, review findings B/C/D/E): FR-27 record semantics (`agent` = subagent name; kickoff-window `runId` inheritance), FR-29 per-mode delivery of the usage block (bare: end of report; message: at kickoff settle), FR-30 TUI-only rendering (`pi.appendEntry` + entry renderer — the reports never enter the LLM context), plus AC-38..AC-40. The amendments land in the review-fixes story that blocks this version's epic.

### Goal and context

Every subagent round already captures its usage in `SubagentResult.usage` (input, output, cacheRead, cacheWrite, cost, turns) and every spawn resolves a model and thinking level per role — but both are invisible: the resolution is not displayed anywhere in the TUI (the user cannot tell whether the `kb-agents` config took effect), and the usage is thrown away, so there is no way to know how many tokens and euros the harness consumes, in total or per role. The user wants both made observable, with the spend persisted across runs.

### Actors

- **Extension user** — watches the subagent rounds in the TUI, reads the /kb-dev report, runs `/kb-cost`.
- **kb subagents** — `kb-planner`, `kb-developer`, `kb-reviewer`, `kb-qa`, spawned by the `kb_agent` tool and the `/kb-dev` command; each round is recorded in the ledger.

### Functional requirements

**FR-23 — kb_agent tool streams the resolved config.** The kb_agent tool resolves the role's model and thinking level (FR-20) and surfaces them while the subagent runs: every `onUpdate` carries them both in the streamed text and in `details` (`{ agent, running, model, thinkingLevel }`), so the default rendering shows them even without a custom renderer.

**FR-24 — Custom rendering for kb_agent.** The tool registers `renderCall`/`renderResult` so the TUI renders the resolved model and thinking level next to the agent name for a running call, and in the final tool result rendering.

**FR-25 — Round results carry the resolved config.** `AgentRoundResult` (the orchestration seam) is extended with the resolved `model`, `thinkingLevel` and `usage` of the round; every round line of the /kb-dev report (`reportRound`) lists the model (and thinking level) it ran with.

**FR-26 — Message-mode kickoff states the dispatch config.** The kickoff delivered to the main agent in message mode states the resolved model and thinking level per role that the rounds will be dispatched with.

**FR-27 — Usage ledger.** *(amended 2026-11-14)* Every subagent round appends one JSON record (one per line) to `<project>/.pi/kb-usage.jsonl`: `{ runId, at, agent, role, model, thinkingLevel, item, ok, usage: { input, output, cacheRead, cacheWrite, cost, turns } }`. `agent` is the **subagent name** (`kb-planner` / `kb-developer` / `kb-reviewer` / `kb-qa`); the kb claim actor is **not stored** — it is recomputable deterministically from `agent` + `item` (`actorForAgent(agent)`, plus `-<item>` when the round targets one). `item` is the kb item ID when the round targets one, `null` otherwise (e.g. a kb_agent call without an item). `runId` identifies the /kb-dev invocation: a kb_agent call **inherits the runId of the active kickoff window** when one is open (FR-29), otherwise it gets its own per-call id. The file is append-only and never rewritten; malformed lines are skipped on read.

**FR-28 — Persistence points.** Both spawn paths record to the ledger: the dev/review/qa rounds of the /kb-dev orchestration (bare and message mode) and every kb_agent tool invocation. Failed rounds are recorded too (`ok: false`). A ledger write failure never fails the round or the run.

**FR-29 — /kb-dev report totals.** *(amended 2026-11-14)* This run's token and euro totals and per-role (planner/developer/reviewer/qa) breakdown, with cacheRead and cacheWrite reported separately so the effective cost is interpretable. Delivery is per mode:
- **Bare mode**: the block lands at the end of the final report, aggregating this run's ledger records by `runId` (all rounds pass through the dispatch seam).
- **Message mode**: the kickoff opens a **kickoff window** — the /kb-dev `runId` becomes the active kickoff in extension memory. Every kb_agent call inside the window records with that `runId` (FR-27), so the dev rounds the main agent spawns are attributed to the run. When the agent settles (`pi.on("agent_settled")`, `ctx.isIdle()` true), the extension emits the "Usage this run" block for the window's records — sweep plus kickoff rounds alike — through the TUI-only channel of FR-30 and closes the window. A window that recorded no rounds emits no block. The report printed at kickoff delivery states that the usage follows at the end of the kickoff run.

**FR-30 — `/kb-cost` command.** *(amended 2026-11-14)* Reads the ledger and renders the cumulative totals across all runs as **markdown**: a table with one row per role (columns: role, model, tokens in/out, cache read/write, cost) plus a bold totals row; overall tokens and euros, breakdown per role and per model. Works with an empty or missing ledger (renders zeros). Delivery is **TUI-only**: `pi.appendEntry` + `pi.registerEntryRenderer` — custom entries do **not** participate in LLM context, so the table never reaches the model (usable even while the agent is busy, no `isIdle` guard). The entry renderer reproduces the validated prototype look (the real `Markdown` component inside a `customMessageBg`-styled block, GFM table with bold totals row). The same TUI-only channel carries the message-mode "Usage this run" block of FR-29.

**FR-31 — Usage returned to pi.** The kb_agent tool result carries the round's `usage`, so pi persists it on the tool result and includes it in the session totals (footer, `/session`).

### Non-functional requirements

- **NFR-15 (robustness):** ledger I/O must never crash or abort a run; a missing/unreadable/corrupt ledger degrades to skipping records on read and, on write failure, to running unrecorded.
- **NFR-16 (no new dependencies):** only the existing pi packages and Node builtins (`fs`).
- **NFR-17 (testability):** the ledger lives in a pure module (`lib/usage-ledger.ts`: append/read/aggregate, no pi imports); the aggregation functions are pure and unit-tested; the existing suite covers the streaming, the report lines, the kickoff and the command output.

### Acceptance criteria

- **AC-31:** during a kb_agent call the TUI shows the resolved model and thinking level of the running subagent (streamed text, `details`, and the custom rendering).
- **AC-32:** every round line of the /kb-dev report lists the model and thinking level the round ran with.
- **AC-33:** the message-mode kickoff states the resolved per-role model and thinking level.
- **AC-34:** every subagent round — orchestration and kb_agent, success or failure — is persisted to the ledger with run, item, role, model, thinking level, tokens and cost.
- **AC-35:** the /kb-dev report shows this run's token/euro totals and per-role breakdown, with cache read/write separate.
- **AC-36:** `/kb-cost` prints, with one command, the cumulative totals across runs broken down per role and per model; an empty ledger prints zeros.
- **AC-37:** the kb_agent tool result carries `usage` and pi's session totals include the subagent spend.
- **AC-38:** *(added 2026-11-14)* a kb_agent call made while a kickoff window is open is recorded with the kickoff's `runId`; the window closes at `agent_settled`, which emits the "Usage this run" block for its records (a window with no recorded rounds emits no block).
- **AC-39:** *(added 2026-11-14)* the `/kb-cost` table and the "Usage this run" blocks are delivered TUI-only (`appendEntry` + entry renderer) and never enter the LLM context; `/kb-cost` is usable while the agent is busy.
- **AC-40:** *(added 2026-11-14)* ledger records carry `agent` = subagent name (`kb-developer`, …) and the claim actor is recomputable from `agent` + `item`; the record shape matches FR-27 exactly.

### Dependencies and constraints

- Depends on: FR-20/FR-21 (per-role resolution and forwarding), the usage capture in `SubagentResult` (lib/subagent.ts), the pi extension tool API (`onUpdate` partial results with `details`, `renderCall`/`renderResult`, usage accounting on tool results — docs/extensions.md).
- The ledger sits next to the project-local config override (`.pi/`, FR-15 precedent); the choice of JSONL over a JSON array is deliberate: append-only for crash safety and concurrent sessions, with `/kb-cost` as the read path.
- **Visual reference — follow faithfully:** the TUI design of this version was validated in advance with the interactive prototype `prototype/kb-tui-prototype.mjs` (gitignored, local to this checkout; run with `node prototype/kb-tui-prototype.mjs`). It renders the target layout with the **real pi-tui components and the real theme** — the implementation of FR-23/FR-24/FR-29/FR-30 must reproduce it faithfully:
  - **FR-23/24 land as variant A** — model and thinking level inline on the tool-call title line, next to the agent name (`kb_agent kb-developer [model · thinking high]`), thinking badge colored with the theme's per-level token (`thinkingHigh`, …);
  - the kb_agent tool-call shell is pi's own: `ToolExecutionComponent` wraps custom renderers in a state-tinted `Box` (`toolPendingBg`/`toolSuccessBg`) — the renderer draws no framing;
  - the round result footer carries duration, tokens in/out, cache r/w, cost and turns (variant A usage line);
  - **FR-29** usage blocks and **FR-30** `/kb-cost` output are markdown rendered by the real `Markdown` component inside a `customMessageBg`-styled block — the cost breakdown is a GFM table with a bold totals row, exactly as the prototype renders it; since the 2026-11-14 amendment the delivery channel is TUI-only (`appendEntry` + entry renderer), so the look is unchanged but the content never enters the LLM context.
- Board: KB-40 (tui-model-display, 3 pt), KB-41 (usage-ledger, 5 pt), both currently in `backlog`.

### Out of scope

- Budget limits, alerts or pricing policies: the ledger records what was spent; it does not gate anything.
- A per-item cost view in `/kb-cost` (the records carry `item` for attribution, but the command aggregates by role and model only).
- Cost recomputation or currency conversion: `cost` is whatever the usage events reported at capture time.

## v0.2.0 — 2026-11-13

Changes vs v0.1.3: per-agent **thinking level** configuration. The config format becomes `kb-agents` (per-role objects with `model` and `thinking-level`); the old `models` format is no longer supported. `--model` and `--thinking` are forwarded to the spawned subagents independently, with the session's thinking level always forwarded as fallback. This section lands the work originally specced on 2026-11-11 on the reference branch `feature/kb-agents-thinking-config`, redone on top of v0.1.3 — it now includes the fourth `qa` role and the extension-folder config location.

### Goal and context

Today only the **model** is configurable per role; the thinking level of the dispatching session is forwarded only when the model is inherited — an explicit model silently drops the session's thinking level. The user wants explicit per-role control over both properties. The config now also covers the fourth role (kb-qa) and is read from the extension folder (FR-15).

### Actors

- **Extension user** — edits `kb-workflow.json` (extension folder and/or project-local `.pi/kb-workflow.json`).
- **kb subagents** — `kb-planner`, `kb-developer`, `kb-reviewer`, `kb-qa`, spawned by the `kb_agent` tool and the `/kb-dev` command.

### Functional requirements

**FR-16 — New config format (`kb-agents`).** The config JSON replaces the `models` object with `kb-agents`; each of the four roles becomes an object with two optional properties:

```json
{
	"kb-agents": {
		"planner":   { "model": "provider/model", "thinking-level": "high" },
		"developer": { "model": "provider/model", "thinking-level": "medium" },
		"reviewer":  { "model": "provider/model", "thinking-level": "low" },
		"qa":        { "model": "provider/model", "thinking-level": "low" }
	}
}
```

**FR-17 — Breaking change.** The old `models` format is no longer supported: a config file without a valid `kb-agents` object contributes nothing to the resolution (silently ignored, consistent with the existing behavior for malformed files). Note: since v0.1.3 the shipped config IS read — the repo's and installed `kb-workflow.json` must be rewritten together with this change (FR-22), otherwise every role silently falls back to the session model.

**FR-18 — Config resolution and deep merge.** Same file locations and order as FR-15 (extension folder global + project-local `.pi` override, later wins). The two files merge **deeply, per single property**: for each role, `model` and `thinking-level` are merged independently (e.g. the model from one file with the thinking level from the other).

**FR-19 — thinking-level validation.** `thinking-level` accepts only the thinking levels recognized by pi: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. An unknown value is ignored (treated as unset) and the fallback applies; it never causes a hard failure.

**FR-20 — Fallback rules.** `model` unset for a role → the subagent inherits the model active in the dispatching pi session. `thinking-level` unset (or invalid) → the subagent inherits the thinking level of the dispatching pi session; **this is always forwarded, including when the model is explicitly configured** — a deliberate change from the current behavior where an explicit model implied the model's default thinking level.

**FR-21 — Subagent invocation.** `runSubagent` builds the `pi` CLI args so that `--model` and `--thinking` are passed independently of each other, according to the per-role resolution above (`resolveAgentConfig` returns both properties; the dispatchers in `index.ts` use it).

**FR-22 — Documentation and config rewrite.** `README.md` ("Model configuration" section), the header comment of `index.ts`, `kb-workflow.example.json`, and the repo's own `kb-workflow.json` are rewritten in the new format.

### Non-functional requirements

- **NFR-12 (robustness):** malformed or non-conforming config files must never crash the extension; they are ignored.
- **NFR-13 (no new dependencies):** only the existing pi packages (pi-agent-core's `ThinkingLevel` type may be referenced).
- **NFR-14 (testability):** `lib/config.ts` stays a pure module; the existing suite (`lib/*.test.ts`) covers the new shape, the deep merge, the validation, the fallback rules and the forwarding.

### Acceptance criteria

- **AC-23:** a config file in the new format is loaded and, for each role, `model` and `thinking-level` are resolved and passed to the spawned `pi` process as `--model` / `--thinking` respectively.
- **AC-24:** a config file in the old `models` format is ignored entirely (no role resolution from it; fallbacks apply).
- **AC-25:** extension-folder and project configs merge per property: a role defined in both files takes `model` from one and `thinking-level` from the other when each file defines only one of the two.
- **AC-26:** a `thinking-level` outside the allowed set is ignored and the session's thinking level is forwarded instead.
- **AC-27:** a role that defines only `model` spawns with both `--model <configured>` and `--thinking <session level>`.
- **AC-28:** a role fully absent from the config inherits the session's model and thinking level.
- **AC-29:** the `qa` role is resolved like the other three.
- **AC-30:** `README.md`, the `index.ts` header comment, `kb-workflow.example.json` and the repo's `kb-workflow.json` document/show the new `kb-agents` format.

### Dependencies and constraints

- Depends on: FR-15 (config location), the pi CLI flags `--model` / `--thinking` of the spawned `pi` process, the pure-module split (`lib/config.ts` / `lib/config-load.ts`).
- The redo adapts the reference implementation from the branch `feature/kb-agents-thinking-config` (kept as reference, not merged).
- Board: the work redoes KB-2..KB-5 (moved back to `todo`) on top of the current develop; KB-6..KB-10 (forwarding, docs) follow in the same epic KB-1.

### Out of scope

- Backward compatibility with the old `models` format.
- Any change to the subagent system prompts (`agents/*.md`).
- Any change to the config file location (FR-15 stays).

## v0.1.3 — 2026-11-13

Changes vs v0.1.2: the global `kb-workflow.json` moves home. The loader reads it from the **extension's own folder** (where the extension code lives and the file is shipped) instead of the agents folder (`getAgentDir()`). The agents-folder lookup is removed entirely.

### Goal and context

The installed extension ships `kb-workflow.json` in its own folder (e.g. `~/.pi/agent/extensions/kb-workflow/kb-workflow.json`), but `loadKbWorkflowConfig` looks for the global config in the agents folder (`~/.pi/agent/kb-workflow.json`) — a file that does not exist. The shipped config is silently ignored and every role falls back to the session model. The config must be read where the extension actually ships it.

### Functional requirements

**FR-15 — Config file location.** `loadKbWorkflowConfig` must read:
1. the global config from the **extension's own folder** — the folder containing the extension code, resolved relative to the module at runtime (e.g. via `import.meta.url`), never via `getAgentDir()`;
2. the project-local override from `<project>/.pi/kb-workflow.json` (unchanged).

The agents-folder lookup (`getAgentDir()/kb-workflow.json`) is removed entirely — no fallback. The merge rules and every other loading behavior are unchanged.

### Non-functional requirements

- **NFR-11 (source parity):** the loader must work identically when the extension runs from the repo (source) and from the installed folder: the path is always derived from the module location, never hard-coded.

### Acceptance criteria

- **AC-22:** the loader reads `kb-workflow.json` from the extension's own folder (module-relative); a config placed there takes effect; a file in the agents folder is ignored; the project-local `.pi` override still wins per property.

### Dependencies and constraints

- This change **blocks the v0.2.0 epic (KB-1)**: the config rework (kb-agents shape, per-role model and thinking-level resolution) must land on the corrected loading path.
- Compatible with both config shapes: the old `models` shape (current) and the `kb-agents` shape (v0.2.0 redo).

### Out of scope

- Any change to the config format (that is the v0.2.0 redo, KB-6..KB-10).
- Any additional fallback path.

## v0.1.2 — 2026-11-13

Changes vs v0.1.1: two things. First, the format of this document: version sections are now ordered newest-first (keepachangelog style) — new versions are inserted at the top instead of appended at the end. Second, the bare invocation of `/kb-dev` returns to story granularity — resolved by the kb DAG via an epic-scoped fallback chain (`kb next --type epic` → `kb next --type story --parent <epic>`, then board-wide story, then single task) — and the story/epic review routing is pinned down with one uniform trigger: kb-reviewer reviews tasks and subtasks, kb-qa reviews stories and epics. Task-branch merging stays with kb-reviewer (FR-4 unchanged).

### Goal and context

v0.1.1 made the bare mode work one task per invocation (`kb next` at task level). In practice the story is the unit of work: a story's tasks build on each other and only make sense together, so a run should take a story and finish it. Meanwhile the kb-qa agent (v0.1.0 FR-5/FR-6/FR-8, not yet implemented) needs a trigger that works identically whether the run was driven by the DAG or by a user message.

- **`/kb-dev`** (no arguments) — the unit of work is the **story**: the first valid story per the kb DAG, scoped by the first available epic (`kb next --type epic` → `kb next --type story --parent <epic>`, falling back to a board-wide `kb next --type story`, then to a single `kb next` task/bug for items reopened under done parents). The whole story is worked (each task through its full branch/developer/review/merge cycle, in DAG order), then the story is reviewed by kb-qa; if the parent epic in turn reaches `review`, it is reviewed too. One story per invocation.
- **`/kb-dev <message>`** — unchanged from v0.1.1: the message drives what gets worked, through the main agent kickoff.
- **Uniform kb-qa trigger** — whenever a story or an epic is in the `review` column, a kb-qa round runs on it: validate acceptance criteria against the merged work on `develop`, verify that every task branch is merged, delete the task branches, move the item to `done` (or back to `todo`). The startup sweep routes items by type: tasks and subtasks to kb-reviewer, stories and epics to kb-qa — in both modes.

### Actors

- **`/kb-dev` handler (deterministic TypeScript)** — pre-flight; differentiated review sweep; in bare mode resolves the unit via the FR-11 chain (epic-scoped story → board-wide story → single task/bug), works it, and spawns the kb-qa rounds; in message mode delivers the kickoff.
- **Main pi agent (message mode only)** — interprets the message, works the identified items, and — per the kickoff template — spawns kb-qa rounds for stories/epics that reach `review`.
- **`kb-reviewer`** — reviews tasks and subtasks only; merges the task branch into `develop` (FR-4, unchanged).
- **`kb-qa`** — reviews stories and epics only; never merges; verifies merges and deletes task branches (FR-7).

### Functional requirements

**FR-11 — Bare invocation: story-level retrieval, epic-scoped (supersedes FR-9).** When invoked without arguments, after the FR-1 pre-flight and the FR-12 sweep, the handler must resolve the unit of work with a fallback chain, stopping at the first success:
1. `kb next --type epic` — if an epic is available, it scopes the selection: resolve the story with `kb next --type story --parent <epic>`;
2. if no epic is available (or the scoped query returns nothing), resolve the story board-wide with `kb next --type story` (covers stories reopened under a done epic);
3. if no story is available, resolve a single task or bug with `kb next` (covers tasks/bugs reopened under a done story);
4. if nothing is available at any level, notify the user and take no further action.
The resolved unit is then worked:
- **story** — worked in full: for each of its tasks, in DAG order (`kb next --parent <story>`), the full cycle runs (FR-2 branch per task, kb-developer round with the existing retry policy, FR-4 review with merge); when every task of the story is done and the story reaches `review`, the kb-qa story review runs (FR-13), and if the parent epic reaches `review` in turn (all sibling stories done), the kb-qa epic review runs;
- **task/bug** — worked through its single cycle (branch, developer round, review with merge).
The invocation stops after the unit's cycle. The epic only scopes which story is taken: one story per invocation, never a whole epic in one run.

**FR-12 — Startup review sweep, differentiated (redefines FR-9 step 1 and FR-10 step 2).** At the start of every `/kb-dev` invocation — both modes, shared code — items already sitting in the `review` column are completed first, routed by type:
- **tasks and subtasks** → kb-reviewer rounds (FR-4: verdict, merge of the task branch into `develop`, `done`/`todo`);
- **stories and epics** → kb-qa rounds (FR-13).

**FR-13 — kb-qa review of stories and epics: uniform trigger (details FR-5/FR-6).** Whenever a story or epic is in the `review` column — left by a previous run, reached by the bare story loop, or reached during message-driven work — a kb-qa round runs on it:
1. validate the item's acceptance criteria (`kb show <ID> --json`) against the merged work on `develop`;
2. **OK**: verify every task branch of the story (`feature/<id>`, `fix/<id>`) is merged into `develop` (tip is an ancestor of `develop`), delete them with `git branch -d`, check all criteria, add a note, `kb move <ID> done`;
3. **problems**: add a note and `kb move <ID> todo`.
kb-qa **never merges branches**: task-level integration stays with kb-reviewer (FR-4). Only task branches are deleted, only with `-d` (FR-7).
In bare mode the handler spawns the kb-qa round; in message mode the kickoff template instructs the main agent to spawn it via the `kb_agent` tool.

**FR-14 — Kickoff template gains the kb-qa step (extends FR-10 step 3).** The fixed kickoff template instructs the main agent, after working the identified items: whenever a story or epic reaches `review` during the message-driven work, spawn a kb-qa round on it (procedure of FR-13) before finishing.

### Non-functional requirements

- **NFR-9 (document format):** SPEC.md sections are ordered newest-first; a new version is inserted at the top; existing sections are never rewritten.
- **NFR-10 (merge unchanged):** the FR-4 merge chain stays with kb-reviewer at task level; kb-qa only verifies ancestry and deletes branches. (Moving task-branch merging to kb-qa was rejected: each task branch must be merged right after its review so that the next task's branch starts from an up-to-date `develop`.)

### Acceptance criteria

- **AC-17:** `/kb-dev` without arguments resolves the unit via the chain epic-scoped story (`kb next --type epic` → `kb next --type story --parent <epic>`) → board-wide story (`kb next --type story`) → single task/bug (`kb next`); it works one story in full (all tasks through their cycles, kb-qa review of the story and, if triggered, of the epic) or the single task in the fallback case, then stops; with nothing available at any level the user is notified and nothing happens.
- **AC-18:** The startup sweep routes tasks/subtasks to kb-reviewer and stories/epics to kb-qa, in both modes (shared code).
- **AC-19:** A story (or epic) in `review` gets a kb-qa round: on success every task branch is verified merged and deleted with `git branch -d` and the item is `done`; on failure the item goes back to `todo` with a note; kb-qa performs no merge.
- **AC-20:** The kickoff template instructs the main agent to run kb-qa rounds on stories/epics that reach `review` during message-driven work.
- **AC-21:** The extension tests cover: the FR-11 resolution chain (epic-scoped story, board-wide story fallback, task fallback, nothing-available), one story per invocation, sweep routing by item type, and the kb-qa trigger in both modes.

### Dependencies and constraints

- Depends on: v0.1.1 in full (dispatch/bare-mode/message-mode modules), the updated `kb` CLI supporting `kb next --type`, and KB-22 (kb-qa registration: prompt, `kb_agent` enum, `models.qa`) for FR-12/FR-13/FR-14. FR-11 is independent of kb-qa.
- Supersession map: FR-9 → FR-11; FR-9 step 1 / FR-10 step 2 → FR-12; FR-10 step 3 → extended by FR-14; FR-5/FR-6 → detailed by FR-13. FR-4 is untouched.
- Constraints: the handler stays deterministic TypeScript; subagent prompts remain authoritative (the kb-qa prompt itself is KB-22's scope).

### Priorities

1. FR-11 (story-level bare retrieval) — independent, can land first.
2. FR-12 + FR-13 (sweep routing + uniform trigger) — after KB-22.
3. FR-14 (kickoff template) — together with FR-13.
4. AC-21 (tests).

### Out of scope

- Moving task-branch merging to kb-qa (rejected — see NFR-10).
- Changes to the FR-4 merge chain, the retry policy, the report format, `/kb-plan`, the `kb` CLI, the plan format, the board rules, or model forwarding (KB-7/KB-8 stay in their own epic).

## v0.1.1 — 2026-11-12

Changes vs v0.1.0: **only how `/kb-dev` retrieves the work items changes**; the per-task machinery (pre-flight, branch per task, autonomous commits, review with merge chain, kb-qa story/epic review) is untouched and is shared by both retrieval modes. `/kb-dev` gains an optional message argument, and its no-argument mode stops selecting work by story: it takes the first available element from the board DAG.

### Goal and context

Today `/kb-dev` picks the first open, unblocked **story** by board position and works it to exhaustion (`kb next --parent <story>` until exit 2). Two needs are unmet:

1. the user cannot steer a run: there is no way to say "work on *this*";
2. selection ignores the board DAG at the top level: the first story by position is chosen even when a later, higher-priority unblocked task exists.

Version 0.1.1 replaces only the retrieval step with two modes:

- **`/kb-dev <message>`** — the message is the retrieval criterion. After pre-flight and after completing any reviews still pending on the board (same as the bare mode), the handler passes the message as a kickoff to the main pi agent (`pi.sendUserMessage`, the same mechanism `/kb-plan` uses): the main agent interprets the message (which may be generic, e.g. "fix the broken tests"), identifies the pertinent items on the board, asks the user for clarification with `ask_user` when the message is ambiguous or maps to no item, and works those items — in DAG order — through the standard pipeline.
- **`/kb-dev`** (no arguments) — the first available **task or bug** on the whole board, resolved by the kb DAG via `kb next` (blockers, then priority, then position), regardless of which story it belongs to. **One element per invocation**: the invocation completes that element's full cycle and stops; the user re-invokes for the next.

### Actors

- **`/kb-dev` handler (deterministic code in `index.ts`)** — parses the command arguments; runs the pre-flight; in message mode hands the message to the main agent; in bare mode resolves the single element via `kb next` and drives the existing per-task loop for it.
- **Main pi agent** — only involved in message mode: interprets the message, selects the items, dispatches the same subagent rounds via the `kb_agent` tool, asks the user when unclear.
- **`kb-developer` / `kb-reviewer` / `kb-qa` subagents** — unchanged: same system prompts, same task prompts, same TDD/merge/qa behavior.

### Functional requirements

**FR-9 — Bare invocation: board-level retrieval.** When invoked without arguments, after the pre-flight checks of FR-1 the handler must:
1. complete the review of any items already sitting in the `review` column (same rounds as today);
2. resolve the next element with `kb next` (board level, no `--parent` filter): the first available task or bug according to the kb DAG — blockers, then priority, then position;
3. work exactly that one element through its full cycle (FR-2 branch per task, developer round with retry, FR-4 review with merge): the element ends `done` (or back in `todo` on problems) and the invocation stops;
4. if `kb next` reports nothing available, notify the user and take no further action.

**FR-10 — Message invocation: user-steered retrieval.** When invoked as `/kb-dev <message>`, the handler must:
1. run the same pre-flight checks of FR-1 (dirty tree aborts before anything else);
2. complete the review of any items already sitting in the `review` column — exactly the same deterministic rounds as FR-9 step 1 (board-wide, one kb-reviewer round per item, FR-4 merge chain);
3. pass the message to the main pi agent as a kickoff via `pi.sendUserMessage`, using a fixed kickoff template that instructs the main agent to: interpret the message as operational instructions; identify the pertinent kb items on the board (by ID/ref or by matching the request against titles, descriptions and test states — generic requests must work); when the message is ambiguous or maps to no item, ask the user with `ask_user` before touching the board; work the identified items in DAG order using the standard pipeline (branch per task per FR-2, kb-developer round with the same retry policy, kb-reviewer round with the FR-4 merge chain, final report);
4. not perform any board or git action itself beyond the pre-flight and the pending-review rounds of step 2: item selection and orchestration belong to the main agent.

### Non-functional requirements

- **NFR-6 (equivalence):** both retrieval modes drive the identical per-task machinery of v0.1.0 (FR-1..FR-8) and share the same pending-review step (items left in `review` by a previous run are completed first, in both modes); no subagent prompt, task prompt, retry policy, report format or model-resolution rule changes.
- **NFR-7 (determinism, bare mode):** the choice of the element is delegated entirely to `kb next` — the handler adds no own ordering and works at most one element per invocation.
- **NFR-8 (safety, message mode):** pre-flight runs before the message is delivered; the main agent makes no board or git change until the pertinent items are identified, and asks the user (`ask_user`) whenever the message does not map to actionable items.

### Acceptance criteria

- **AC-11:** `/kb-dev` without arguments works exactly one element — the first available task or bug per the kb DAG, even if it belongs to a story that is not first by position — and the invocation stops after that element's cycle (report included).
- **AC-12:** `/kb-dev` without arguments when `kb next` finds nothing available: the user is notified and no board or git action is taken.
- **AC-13:** Items left in `review` by a previous run are reviewed (and merged/closed) before a new element is retrieved in bare mode.
- **AC-14:** `/kb-dev <message>` runs the pre-flight, then completes any reviews still pending on the board (same behavior as AC-13), and only then delivers the message to the main agent, which works the identified items in DAG order through the standard pipeline (branch per task, dev round, review with merge).
- **AC-15:** An ambiguous message, or one that maps to no item, causes the main agent to ask the user for clarification via `ask_user` before any board or git change.
- **AC-16:** The extension tests cover both retrieval paths: argument parsing (bare vs message), the bare-mode single-element selection via `kb next`, and the content of the kickoff template (operational interpretation, item identification, ask-first rule, DAG order).

### Dependencies and constraints

- Depends on: v0.1.0 in full (FR-1..FR-8, `lib/git.ts`, `lib/orchestration.ts`), `pi.sendUserMessage` (already used by `/kb-plan`), the `ask_user` tool, `kb next` exit codes (2 = nothing available).
- Board structure: this version is planned as a new epic containing a single story; the epic **blocks KB-11** (v0.1.0 epic) **and KB-1** (v0.2.0 epic), so their remaining items are not available to `/kb-dev` until this change is done — the new retrieval logic must therefore be in place first.
- Constraints: the handler stays deterministic TypeScript; the main agent only receives the fixed kickoff template plus the user message; subagent prompts and `kb guide` rules remain authoritative.

### Priorities

1. FR-9 (bare-mode board-level retrieval) — the default path.
2. FR-10 (message mode) — steering on demand.
3. AC-16 (tests) for both.

### Out of scope

- Any change to the per-task machinery: prompts of the subagents, task prompt templates, retry policy, merge chain, kb-qa behavior, model resolution (KB-7/KB-8 stay as planned in their own epic).
- Any change to `/kb-plan`, the `kb` CLI, the plan format or the board rules.
- Working more than one element per bare invocation, or interactive item selection in bare mode.
## v0.1.0 — 2026-11-11

Changes vs previous release: first versioned specification. It addresses the limitations recorded in `.pi/kb-workflow-memory.md`: no branches were ever created, subagents never committed their work, and nobody ever reviewed the story/epic items themselves. The extension version and the section number of this document advance in lockstep.

### Goal and context

`/kb-dev` currently runs its whole loop (developer subagents implement tasks, reviewer subagents review them) on whatever branch happens to be checked out, leaving everything uncommitted or committed on the wrong branch. Version 0.1.0 integrates a local git workflow into `/kb-dev`:

- every task is developed on its own branch, created from `develop`;
- the developer commits autonomously on that branch;
- the reviewer merges the branch into `develop` when the review succeeds;
- when a story (and then its epic) is completed, the dedicated `kb-qa` agent reviews it against its acceptance criteria, verifies that all its task branches were merged into `develop`, and deletes them.

Everything is local: no push, no pull, no remote interaction.

### Actors

- **`/kb-dev` handler (deterministic code in `index.ts`)** — orchestrates the loop, owns branch creation and checkout; refuses to start on a dirty working tree.
- **`kb-developer` subagent** — implements one task at a time on the active branch; commits freely; must leave a clean working tree before moving the item to `review`.
- **`kb-reviewer` subagent** — reviews one task at a time; on success merges its branch into `develop`; on problems sends the item back to `todo` (branch stays open).
- **`kb-qa` subagent** — at story/epic completion, validates the parent item's acceptance criteria, verifies all task branches are merged into `develop`, then deletes them; on failure sends the story back to `todo`. It is a fourth agent of equal standing: a dedicated system prompt (`agents/kb-qa.md`), an entry in the `kb_agent` tool enum, a `qa` role in the model config (`models.qa`), and the board actor `agent-qa-<ID>`.
- **`kb-planner` subagent** — analysis only: interactive specification, SPEC.md, plan.yaml generation and board import. It never reviews stories or epics; that would muddy its planning semantics.

### Functional requirements

**FR-1 — Pre-flight checks (`/kb-dev` handler).** Before starting any work on a story, the handler must:
1. verify that a kb board and `SPEC.md` exist (as today);
2. run `git status --porcelain`: if the working tree is dirty, abort with an error message asking the user to commit or stash manually — no automatic stash, no auto-commit;
3. `git checkout develop` before the first task of the run.

**FR-2 — Branch per task (`/kb-dev` handler).** Before spawning the `kb-developer` subagent for a task, the handler must, on the local repository:
1. `git checkout develop`;
2. create (or reuse) the task branch named `feature/<KB-id>` or `fix/<KB-id>`, where the prefix is derived from the kb item type (`bug` → `fix/`, anything else → `feature/`);
3. `git checkout` the task branch, so the developer subagent finds it active.

If the branch already exists (e.g. a review round sent the task back to `todo`), the handler reuses it as is — it must never delete or recreate a task branch mid-story.

**FR-3 — Autonomous commits (`kb-developer`).** The developer subagent works on the active branch and commits on its own while progressing (e.g. after each green phase). Before issuing `kb move <ID> review`, the working tree must be clean: all changes committed on the task branch. The current rule "Do not commit or push unless explicitly asked" in `agents/kb-developer.md` is replaced by: commit autonomously on the active branch; never push; never commit on `develop`.

**FR-4 — Review and merge (`kb-reviewer`).** The reviewer reviews the task's changes as the diff of the task branch against `develop` (not the working tree). Verdict:
- **OK**: check all acceptance criteria, add a note, then merge the task branch into `develop` using the following strategy, stopping at the first success:
  1. `git checkout develop` + `git merge --ff-only <branch>`;
  2. if that fails, `git merge --no-ff <branch>` (with a merge commit message referencing the task ID);
  3. if that also fails (e.g. conflicts), abort the merge (`git merge --abort`), leave the item in `review` and report the failure — `/kb-dev` surfaces the error to the user and stops.
  After a successful merge, `kb move <ID> done` and a final note. Branches are NOT deleted at task level.
- **Problems**: `kb note <ID> "review: <problems>"` and `kb move <ID> todo`; the task branch stays open so the developer can continue on it in the next round.

**FR-5 — Story review (`kb-qa`, automatic).** When the `/kb-dev` loop ends with every task of the story in `done`, the handler automatically spawns a `kb-qa` subagent to review the story itself:
1. validate the story's acceptance criteria (`kb show <story> --json`) against the merged work on `develop`;
2. if criteria are not met: `kb note <story> ...` and `kb move <story> todo`, and the loop reports this;
3. if criteria are met: verify that every task branch of the story (`feature/<id>` / `fix/<id>` for each task) has been merged into `develop` (branch tip is an ancestor of `develop`); once verified, delete those branches (`git branch -d`); then `kb accept <story> check <all>`, `kb note <story> ...`, `kb move <story> done`.

**FR-6 — Epic review (`kb-qa`, automatic).** After a story is moved to `done`, if all sibling stories of its parent epic are `done`, the same kb-qa review runs on the epic: validate the epic's acceptance criteria; on success verify that all task branches of every story of the epic are merged into `develop` and delete them, then move the epic to `done`; on failure move the epic back to `todo` with a note.

**FR-7 — Branch deletion policy.** Only task branches (`feature/<KB-id>`, `fix/<KB-id>`) are ever deleted, only by `kb-qa`, only after verifying the merge into `develop` (safe delete `git branch -d`, which refuses unmerged branches). No story-level or epic-level branches exist in this workflow.

**FR-8 — kb-qa agent registration.** `kb-qa` is a first-class role in the extension: a new system prompt file `agents/kb-qa.md` (procedure: identify as `agent-qa-<story/epic ID>`, `kb show <ID> --json`, validate acceptance criteria against the merged work on `develop`, verify branch ancestry, delete task branches, move the item to `done` or back to `todo` with a note); the `agent` parameter of the `kb_agent` tool accepts `kb-qa` alongside kb-planner/kb-developer/kb-reviewer; the model config supports `models.qa` in `kb-workflow.json` with the same fallback-to-session-model rule as the other roles (`resolveAgentModel("qa", ...)`).

### Non-functional requirements

- **NFR-1 (locality):** no network or remote operations anywhere: no push, no pull, no fetch. `origin` may not even exist.
- **NFR-2 (safety):** no destructive git operations: no force operations, no resetting/overwriting of existing task branches mid-story, no `git branch -D` (only `-d`).
- **NFR-3 (robustness):** every git command run by the handler is checked for a non-zero exit code; failures abort the loop with a clear error surfaced to the user via `ctx.ui.notify(..., "error")` and the final report.
- **NFR-4 (observability):** the `/kb-dev` final report lists, per task: branch name, merge outcome (ff / no-ff / failed), and the story/epic review verdict; the kb-qa branch deletions are listed too.
- **NFR-5 (no regression):** the existing per-task TDD loop, claim/touch lifecycle, `MAX_ATTEMPTS_PER_TASK` and the `review → dev` rounds keep working unchanged; only the branch/commit/merge/story-review concerns are added.

### Acceptance criteria

- **AC-1:** Running `/kb-dev` with a dirty working tree shows an error and performs no board or git action.
- **AC-2:** For every task, a branch `feature/<id>` or `fix/<id>` (prefix chosen by kb item type) exists, created from `develop`, and is checked out while the developer works; a re-run for the same task reuses the existing branch.
- **AC-3:** After the developer finishes a task, `git status --porcelain` on the task branch is empty and at least one commit for the task exists on the branch.
- **AC-4:** After a successful review, the task's changes are reachable from `develop` (ff or --no-ff merge) and the item is `done`; the task branch still exists.
- **AC-5:** When a review fails with merge conflicts, the item remains in `review`, `develop` is unchanged (merge aborted), and the error is reported to the user.
- **AC-6:** When a review sends a task back to `todo`, the task branch survives and the next developer round on that task does not create a new branch.
- **AC-7:** When all tasks of a story are `done`, a kb-qa review of the story runs automatically; on success the story is `done`, all its task branches are deleted, and none of the deleted branch tips is missing from `develop`; on failure the story is `todo` with an explanatory note.
- **AC-8:** When all stories of an epic are `done`, the epic gets the same kb-qa treatment automatically. The kb-planner subagent is never spawned for story/epic reviews.
- **AC-9:** No command in the extension performs any remote git operation.
- **AC-10:** The unit/integration tests of the extension cover: branch naming/prefix choice, branch reuse, ff→no-ff→abort merge chain, dirty-tree pre-flight, and "all branches merged" verification before deletion.

### Dependencies and constraints

- Depends on: `git` available in the project environment; the existing `lib/kb.ts` (`runKb`, `KbItem`), `lib/subagent.ts` (`runSubagent`), `lib/config.ts` (extended with the `qa` role in `AgentRole`), the `kb` CLI the `kb` CLI with `list/show/claim/move/note/accept/phase/test/touch` as used today.
- Constraints: the handler stays deterministic TypeScript (git plumbing in `index.ts` or a new `lib/git.ts`); subagents only receive their instructions through the fixed task prompts and their system prompts (`agents/*.md`); the plan format and board rules of `kb guide` are authoritative.

### Priorities

1. FR-1/FR-2 (branch per task) and FR-3 (commits) — the core gap.
2. FR-4 (review + merge) — makes the branch flow meaningful.
3. FR-8 + FR-5/FR-6 (kb-qa agent and its story/epic review + branch cleanup) — closes the memory's points 3 and 4.
4. NFR-4 (reporting) and AC-10 (tests).

### Out of scope

- Any remote operation: push, pull, fetch, remote branch deletion.
- Story-level or epic-level branches.
- Handling/cleanup of pre-existing historical branches (e.g. `feature/base_workflow`, `feature/kb-agents-thinking-config`).
- Automatic conflict resolution on merge.
- Parallel task execution (the loop stays sequential, one task at a time).

