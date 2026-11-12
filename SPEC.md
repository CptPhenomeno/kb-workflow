# kb-workflow — Specification

This document specifies the `kb-workflow` pi extension: the `/kb-plan` and `/kb-dev` commands and the kb-planner / kb-developer / kb-reviewer / kb-qa subagents that drive the `kb` kanban board end to end. Each section is one version of the extension; sections are never rewritten, only appended.

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
