/**
 * Bare-mode orchestration for /kb-dev (SPEC v0.1.1, FR-9).
 *
 * After the FR-1 pre-flight the handler:
 *   1. completes the review of any items already sitting in the `review`
 *      column, routed by type (FR-12): tasks/subtasks to kb-reviewer,
 *      stories/epics to kb-qa;
 *   2. resolves the next element with `kb next` at board level (no --parent
 *      filter) — first available task or bug per the kb DAG;
 *   3. works exactly that one element through its full cycle (FR-2 branch
 *      per task via runDeveloperRound, developer round with the existing
 *      retry policy, kb-reviewer round with the FR-4 merge chain) and stops.
 *
 * If `kb next` exits 2 (nothing available), the user is notified and no
 * action is taken. The handler adds no own ordering (NFR-7): the kb DAG
 * decides which element comes next.
 *
 * All side-effectful seams (kb CLI, subagent spawns, notifications) are
 * injected so the flow is unit-testable without real subagents.
 */

import { runDeveloperRound } from "./orchestration.ts";
import { kbErrorMessage, type KbItem, type KbRun } from "./kb.ts";

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
	/** Spawn the kb-developer subagent for a task. */
	spawnDev: (task: KbItem) => Promise<AgentRoundResult>;
	/** Spawn the kb-reviewer subagent for a task/subtask in the review column. */
	spawnReviewer: (item: KbItem) => Promise<AgentRoundResult>;
	/** Spawn the kb-qa subagent for a story/epic in the review column (FR-13). */
	spawnQa: (item: KbItem) => Promise<AgentRoundResult>;
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
	deps: Pick<BareModeDeps, "kb" | "spawnReviewer" | "spawnQa" | "setStatus">,
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
			const rev = await deps.spawnReviewer(item);
			reportRound(report, "review", item, rev);
		} else {
			deps.setStatus?.(`qa ${item.id}`);
			const qa = await deps.spawnQa(item);
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
	deps: Pick<BareModeDeps, "kb" | "spawnQa" | "setStatus">,
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
		const qa = await deps.spawnQa(parent);
		reportRound(report, "qa review", parent, qa);
		reviewed.push(parent);
		currentId = parent.id;
	}
	return reviewed;
}

export async function runBareDev(deps: BareModeDeps): Promise<BareModeResult> {
	const report: string[] = ["# /kb-dev report — board-level run", ""];
	const notify = deps.notify ?? (() => {});

	// 1. Complete the review of items already sitting in the review column,
	//    board-wide, one kb-reviewer round per item (FR-9 step 1, AC-13).
	await sweepPendingReviews(deps, report);

	// 2. Resolve the next element at board level (FR-9 step 2, AC-11).
	const next = await deps.kb(["next"]);
	if (next.code === 2) {
		notify("Nothing available on the board: no task or bug is ready to work on.", "info");
		report.push("", "Nothing available on the board (`kb next` found no task or bug ready to work on).");
		return { report: report.join("\n") };
	}
	if (next.code !== 0) {
		const msg = kbErrorMessage(next);
		notify(`kb next failed: ${msg}`, "error");
		report.push(`- kb next failed: ${msg}`);
		return { report: report.join("\n") };
	}
	const element = next.json as KbItem;

	// 3. Work exactly that one element through its full cycle, then stop.
	let devOk = false;
	for (let attempt = 1; attempt <= MAX_DEV_TRIES && !devOk; attempt++) {
		deps.setStatus?.(`dev ${element.id} (try ${attempt})`);
		const round = await runDeveloperRound({
			cwd: deps.cwd,
			task: element,
			spawnDev: () => deps.spawnDev(element),
		});
		const dev = round.result;
		devOk = dev.ok;
		report.push(
			`- dev ${element.id} "${element.title}" (try ${attempt}, branch ${round.branch}): ${dev.ok ? "ok" : "FAILED"} — ${lastLine(dev.output)}`,
		);
		if (!dev.ok) report.push(`  error: ${dev.errorMessage ?? ""} ${dev.stderr.trim().slice(0, 300)}`);
	}
	if (!devOk) {
		report.push(`- element ${element.id} not completed after ${MAX_DEV_TRIES} tries; stopping.`);
		return { report: report.join("\n") };
	}

	// FR-4 review round for the element (merge chain inside the reviewer).
	deps.setStatus?.(`review ${element.id}`);
	const rev = await deps.spawnReviewer(element);
	reportRound(report, "review", element, rev);

	// FR-13: if the parent story (and in turn the epic) reached `review` with
	// this task done, spawn the kb-qa rounds derived from the board state.
	await qaRoundsOnCompletion(deps, report, element.id);

	// Final board state of the element.
	const show = await deps.kb(["show", element.id]);
	const now = (show.code === 0 ? show.json : undefined) as KbItem | undefined;
	if (now) report.push("", `Element ${now.id} is now in column "${now.status}".`);

	return { report: report.join("\n") };
}
