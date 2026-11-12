/**
 * Bare-mode orchestration for /kb-dev (SPEC v0.1.1, FR-9).
 *
 * After the FR-1 pre-flight the handler:
 *   1. completes the review of any items already sitting in the `review`
 *      column (board-wide, one kb-reviewer round per item);
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
	/** Spawn the kb-reviewer subagent for an item in the review column. */
	spawnReviewer: (item: KbItem) => Promise<AgentRoundResult>;
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
 * Complete the review of any items already sitting in the `review` column:
 * board-wide, one kb-reviewer round per item, in deterministic order
 * (position, then id). Shared by both retrieval modes (FR-9 step 1 and
 * FR-10 step 2, NFR-6). Returns the swept items.
 */
export async function sweepPendingReviews(
	deps: Pick<BareModeDeps, "kb" | "spawnReviewer" | "setStatus">,
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
		deps.setStatus?.(`review ${item.id}`);
		const rev = await deps.spawnReviewer(item);
		reportRound(report, "review", item, rev);
	}
	return reviewItems;
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

	// Final board state of the element.
	const show = await deps.kb(["show", element.id]);
	const now = (show.code === 0 ? show.json : undefined) as KbItem | undefined;
	if (now) report.push("", `Element ${now.id} is now in column "${now.status}".`);

	return { report: report.join("\n") };
}
