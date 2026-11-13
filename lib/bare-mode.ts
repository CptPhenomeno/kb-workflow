/**
 * Bare-mode orchestration for /kb-dev (SPEC v0.1.1, FR-9).
 *
 * After the FR-1 pre-flight the handler:
 *   1. completes the review of any items already sitting in the `review`
 *      column, routed by type (FR-12): tasks/subtasks to kb-reviewer,
 *      stories/epics to kb-qa;
 *   2. resolves the unit of work with the FR-11 chain (epic-scoped
 *      story → board-wide story → single task/bug);
 *   3. works the unit: a story in full — each of its tasks, in DAG order
 *      (`kb next --parent <story>` until exit 2), through the full cycle
 *      (FR-2 branch per task via runDeveloperRound, developer round with
 *      the existing retry policy, kb-reviewer round with the FR-4 merge
 *      chain), with the FR-13 kb-qa rounds for the story (and, if all
 *      sibling stories are done, the epic) — or the single fallback
 *      task/bug through its one cycle; then stops.
 *
 * If `kb next` exits 2 (nothing available), the user is notified and no
 * action is taken. The handler adds no own ordering (NFR-7): the kb DAG
 * decides which element comes next.
 *
 * All side-effectful seams (kb CLI, subagent spawns, notifications) are
 * injected so the flow is unit-testable without real subagents.
 */

import { resolveAgentConfig, type KbWorkflowConfig, type RoleConfig, type SessionFallbacks } from "./config.ts";
import { runDeveloperRound } from "./orchestration.ts";
import { kbErrorMessage, type KbItem, type KbRun } from "./kb.ts";
import { roleOf } from "./agent-tool.ts";
import type { KbAgentName } from "./subagent.ts";

/** What a subagent round returns (the relevant slice of SubagentResult). */
export interface AgentRoundResult {
	ok: boolean;
	output: string;
	stderr: string;
	errorMessage?: string;
}

export interface BareModeDeps {
	cwd: string;
	/** Stands in for `runKb(args, cwd)`. */
	kb: (args: string[]) => Promise<KbRun>;
	/** Parsed kb-workflow config for the per-role resolution (FR-20). */
	config?: KbWorkflowConfig;
	/** The dispatching session's model and thinking level (fallbacks, FR-20). */
	session?: SessionFallbacks;
	/** Spawn the kb-developer subagent for a task, with the resolved config. */
	spawnDev: (task: KbItem, resolved: RoleConfig) => Promise<AgentRoundResult>;
	/** Spawn the kb-reviewer subagent for a task/subtask in the review column. */
	spawnReviewer: (item: KbItem, resolved: RoleConfig) => Promise<AgentRoundResult>;
	/** Spawn the kb-qa subagent for a story/epic in the review column (FR-13). */
	spawnQa: (item: KbItem, resolved: RoleConfig) => Promise<AgentRoundResult>;
	/** Optional UI notifications (message + level). */
	notify?: (message: string, level: "info" | "error") => void;
	/** Optional UI status line updates. */
	setStatus?: (status: string | undefined) => void;
}

export interface BareModeResult {
	/** The final /kb-dev report. */
	report: string;
}

/** Same retry policy as v0.1.0: one automatic retry on developer failure. */
const MAX_DEV_TRIES = 2;

const lastLine = (s: string): string => {
	const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
	return lines.length ? lines[lines.length - 1] : "(no output)";
};

const reportRound = (report: string[], kind: string, item: KbItem, r: AgentRoundResult) => {
	report.push(`- ${kind} ${item.id} "${item.title}": ${r.ok ? "ok" : "FAILED"} — ${lastLine(r.output)}`);
	if (!r.ok) report.push(`  error: ${r.errorMessage ?? ""} ${r.stderr.trim().slice(0, 300)}`);
};

/**
 * Resolve both properties for a role against the injected config and session
 * (FR-20): each falls back independently to the dispatching session's value.
 */
export function resolveForRole(
	agent: KbAgentName,
	deps: Pick<BareModeDeps, "config" | "session">,
): RoleConfig {
	return resolveAgentConfig(roleOf(agent), deps.config ?? {}, deps.session);
}

/** True when the item is reviewed by kb-reviewer (task-level, FR-4 merge chain). */
function isTaskLevel(item: KbItem): boolean {
	return item.type === "task" || item.type === "subtask" || item.type === "bug";
}

/**
 * Complete the review of any items already sitting in the `review` column,
 * routed by type (FR-12): tasks and subtasks (and bugs) get a kb-reviewer
 * round (FR-4 merge chain), stories and epics get a kb-qa round (FR-13).
 * Shared by both retrieval modes (NFR-6). Returns the swept items.
 */
export async function sweepPendingReviews(
	deps: Pick<BareModeDeps, "kb" | "config" | "session" | "spawnReviewer" | "spawnQa" | "setStatus">,
	report: string[],
): Promise<KbItem[]> {
	const reviewRes = await deps.kb(["list", "--status", "review"]);
	if (reviewRes.code !== 0) {
		report.push(`- listing review items failed: ${kbErrorMessage(reviewRes)}`);
		return [];
	}
	const reviewItems = ((reviewRes.json as KbItem[] | undefined) ?? [])
		.filter((i) => i.status === "review")
		.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
	for (const item of reviewItems) {
		if (isTaskLevel(item)) {
			deps.setStatus?.(`review ${item.id}`);
			const rev = await deps.spawnReviewer(item, resolveForRole("kb-reviewer", deps));
			reportRound(report, "review", item, rev);
		} else {
			deps.setStatus?.(`qa ${item.id}`);
			const qa = await deps.spawnQa(item, resolveForRole("kb-qa", deps));
			reportRound(report, "qa review", item, qa);
		}
	}
	return reviewItems;
}

/**
 * Spawn the kb-qa rounds implied by the board state after a task round
 * (FR-13, bare mode): walk up the ancestry from the worked item — if the
 * parent story sits in `review` (all its tasks done), run a kb-qa round on
 * it; if the parent epic in turn sits in `review` (all sibling stories
 * done), run a kb-qa round on it too. kb-qa never merges (NFR-10). The
 * trigger is derived purely from the board state, so it fits the current
 * one-element loop and the story loop of FR-11 alike.
 */
export async function qaRoundsOnCompletion(
	deps: Pick<BareModeDeps, "kb" | "config" | "session" | "spawnQa" | "setStatus">,
	report: string[],
	itemId: string,
): Promise<KbItem[]> {
	const reviewed: KbItem[] = [];
	let currentId = itemId;
	// At most story + epic above a task; guard against cycles anyway.
	for (let depth = 0; depth < 2; depth++) {
		const show = await deps.kb(["show", currentId]);
		const current = (show.code === 0 ? show.json : undefined) as KbItem | undefined;
		if (!current?.parent) break;
		const parentShow = await deps.kb(["show", current.parent]);
		const parent = (parentShow.code === 0 ? parentShow.json : undefined) as KbItem | undefined;
		// Only stories and epics get kb-qa rounds (FR-12/FR-13).
		if (!parent || parent.status !== "review" || isTaskLevel(parent)) break;
		deps.setStatus?.(`qa ${parent.id}`);
		const qa = await deps.spawnQa(parent, resolveForRole("kb-qa", deps));
		reportRound(report, "qa review", parent, qa);
		reviewed.push(parent);
		currentId = parent.id;
	}
	return reviewed;
}

/** The unit of work resolved by the FR-11 chain. */
export interface ResolvedUnit {
	unit: KbItem;
	/** Human-readable provenance, e.g. "epic KB-1-scoped story". */
	via: string;
}

/**
 * Resolve the unit of work with the FR-11 fallback chain, stopping at the
 * first success:
 *   1. `kb next --type epic` — an available epic scopes the selection:
 *      the story is resolved with `kb next --type story --parent <epic>`;
 *   2. with no epic (or an empty scoped query), the story is resolved
 *      board-wide with `kb next --type story`;
 *   3. with no story, a single task or bug with `kb next`;
 *   4. nothing at any level → null (the caller notifies the user).
 * Exit code 2 means "nothing available at this level"; any other non-zero
 * code is an error. The handler adds no own ordering (NFR-7): the kb DAG
 * decides.
 */
export async function resolveUnit(
	deps: Pick<BareModeDeps, "kb">,
	report: string[],
): Promise<ResolvedUnit | null | "error"> {
	const tryNext = async (args: string[]): Promise<KbRun | "none" | "error"> => {
		const res = await deps.kb(args);
		if (res.code === 2) return "none";
		if (res.code !== 0) {
			report.push(`- kb ${args.join(" ")} failed: ${kbErrorMessage(res)}`);
			return "error";
		}
		return res;
	};

	// 1. An available epic scopes the story selection.
	const epicRes = await tryNext(["next", "--type", "epic"]);
	if (epicRes === "error") return "error";
	if (epicRes !== "none") {
		const epic = epicRes.json as KbItem;
		const scoped = await tryNext(["next", "--type", "story", "--parent", epic.id]);
		if (scoped === "error") return "error";
		if (scoped !== "none") {
			return { unit: scoped.json as KbItem, via: `epic ${epic.id}-scoped story` };
		}
		// Empty scoped query: fall through to the board-wide story query.
	}

	// 2. Board-wide story (covers stories reopened under a done epic).
	const storyRes = await tryNext(["next", "--type", "story"]);
	if (storyRes === "error") return "error";
	if (storyRes !== "none") {
		return { unit: storyRes.json as KbItem, via: "board-wide story" };
	}

	// 3. Single task or bug (covers items reopened under a done story).
	const taskRes = await tryNext(["next"]);
	if (taskRes === "error") return "error";
	if (taskRes !== "none") {
		return { unit: taskRes.json as KbItem, via: "task/bug fallback" };
	}

	// 4. Nothing available at any level.
	return null;
}

/**
 * One task's full cycle shared by the story loop and the task/bug
 * fallback (FR-2 branch via runDeveloperRound, developer round with the
 * existing retry policy, FR-4 review round with the merge chain inside
 * the reviewer). Returns true when the task completed its cycle.
 */
async function runTaskCycle(
	deps: BareModeDeps,
	report: string[],
	task: KbItem,
	what: string,
): Promise<boolean> {
	let devOk = false;
	for (let attempt = 1; attempt <= MAX_DEV_TRIES && !devOk; attempt++) {
		deps.setStatus?.(`dev ${task.id} (try ${attempt})`);
		const resolved = resolveForRole("kb-developer", deps);
		const round = await runDeveloperRound({
			cwd: deps.cwd,
			task,
			spawnDev: () => deps.spawnDev(task, resolved),
		});
		const dev = round.result;
		devOk = dev.ok;
		report.push(
			`- dev ${task.id} "${task.title}" (try ${attempt}, branch ${round.branch}): ${dev.ok ? "ok" : "FAILED"} — ${lastLine(dev.output)}`,
		);
		if (!dev.ok) report.push(`  error: ${dev.errorMessage ?? ""} ${dev.stderr.trim().slice(0, 300)}`);
	}
	if (!devOk) {
		report.push(`- ${what} ${task.id} not completed after ${MAX_DEV_TRIES} tries; stopping.`);
		return false;
	}

	// FR-4 review round for the task (merge chain inside the reviewer).
	// A failed review means the task's cycle did not complete (it is not
	// merged/done), so the caller must not move on to the next task.
	deps.setStatus?.(`review ${task.id}`);
	const rev = await deps.spawnReviewer(task, resolveForRole("kb-reviewer", deps));
	reportRound(report, "review", task, rev);
	return rev.ok;
}

/**
 * Work a whole story (FR-11 "worked in full"): for each of its tasks, in
 * DAG order (`kb next --parent <story>` until exit 2), run the full
 * existing cycle — FR-2 branch per task via runDeveloperRound, developer
 * round with the existing retry policy, FR-4 review with merge. After each
 * task's review, qaRoundsOnCompletion walks the story → epic ancestry, so
 * the kb-qa story review (and, if all sibling stories are done, the epic
 * review) fires within the loop (FR-13). Returns the tasks worked.
 */
export async function runStoryLoop(
	deps: BareModeDeps,
	report: string[],
	story: KbItem,
): Promise<KbItem[]> {
	const worked: KbItem[] = [];
	for (;;) {
		const res = await deps.kb(["next", "--parent", story.id]);
		if (res.code === 2) break; // no more tasks: the story is worked in full
		if (res.code !== 0) {
			report.push(`- kb next --parent ${story.id} failed: ${kbErrorMessage(res)}`);
			break;
		}
		const task = res.json as KbItem;

		if (!(await runTaskCycle(deps, report, task, "task"))) break;
		worked.push(task);

		// FR-13: if the parent story reached `review` with this task done
		// (and in turn the epic), spawn the kb-qa rounds.
		await qaRoundsOnCompletion(deps, report, task.id);
	}
	return worked;
}

export async function runBareDev(deps: BareModeDeps): Promise<BareModeResult> {
	const report: string[] = ["# /kb-dev report — board-level run", ""];
	const notify = deps.notify ?? (() => {});

	// 1. Complete the review of items already sitting in the review column,
	//    board-wide, one kb-reviewer round per item (FR-9 step 1, AC-13).
	await sweepPendingReviews(deps, report);

	// 2. Resolve the unit of work via the FR-11 chain
	//    (epic-scoped story → board-wide story → single task/bug).
	const resolved = await resolveUnit(deps, report);
	if (resolved === "error") {
		notify("kb next failed while resolving the unit of work; see the report.", "error");
		return { report: report.join("\n") };
	}
	if (!resolved) {
		notify("Nothing available on the board at any level (epic → story → task).", "info");
		report.push("", "Nothing available on the board at any level (epic → story → task): nothing to work on.");
		return { report: report.join("\n") };
	}
	const element = resolved.unit;
	if (element.type === "story") {
		// The story is the unit of work; it is worked in full (FR-11), one
		// story per invocation.
		report.push(
			`- resolved unit: story ${element.id} "${element.title}" (${resolved.via}); one story per invocation.`,
		);
		const worked = await runStoryLoop(deps, report, element);
		report.push(`- story ${element.id}: ${worked.length} task(s) worked.`);
		const show = await deps.kb(["show", element.id]);
		const now = (show.code === 0 ? show.json : undefined) as KbItem | undefined;
		if (now) report.push("", `Story ${now.id} is now in column "${now.status}".`);
		return { report: report.join("\n") };
	}
	if (element.type === "epic") {
		// The epic only scopes which story is taken; it is never worked
		// directly (one story per invocation).
		report.push(
			`- resolved unit: epic ${element.id} "${element.title}" (${resolved.via}); one story per invocation.`,
		);
		return { report: report.join("\n") };
	}

	// 3. Work exactly that one element through its full cycle, then stop.
	if (!(await runTaskCycle(deps, report, element, "element"))) {
		return { report: report.join("\n") };
	}

	// FR-13: if the parent story (and in turn the epic) reached `review` with
	// this task done, spawn the kb-qa rounds derived from the board state.
	await qaRoundsOnCompletion(deps, report, element.id);

	// Final board state of the element.
	const show = await deps.kb(["show", element.id]);
	const now = (show.code === 0 ? show.json : undefined) as KbItem | undefined;
	if (now) report.push("", `Element ${now.id} is now in column "${now.status}".`);

	return { report: report.join("\n") };
}
