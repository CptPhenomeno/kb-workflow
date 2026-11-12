/**
 * Message-mode orchestration for /kb-dev <message> (SPEC v0.1.1, FR-10).
 *
 * After the FR-1 pre-flight the handler:
 *   1. aborts without any further action if the tree is dirty;
 *   2. completes the review of any items already sitting in the `review`
 *      column (the same shared sweep as the bare mode, NFR-6);
 *   3. passes the message to the main pi agent as a kickoff via
 *      `pi.sendUserMessage` using the fixed `devKickoff` template.
 *
 * The handler performs no board or git action beyond the pre-flight and the
 * pending-review rounds (FR-10 step 4): item selection and orchestration
 * belong to the main agent. All side-effectful seams are injected so the
 * flow is unit-testable without a real pi session.
 */

import { sweepPendingReviews, type AgentRoundResult } from "./bare-mode.ts";
import type { KbItem, KbRun } from "./kb.ts";

export interface MessageModeDeps {
	cwd: string;
	/** The user's message (the retrieval criterion). */
	message: string;
	/** Stands in for `runKb(args, cwd)`. */
	kb: (args: string[]) => Promise<KbRun>;
	/** Stands in for `preFlightCheck(cwd)` (FR-1). */
	preFlight: () => Promise<{ ok: boolean; error?: string; branch?: string }>;
	/** Spawn the kb-reviewer subagent for an item in the review column. */
	spawnReviewer: (item: KbItem) => Promise<AgentRoundResult>;
	/** Stands in for `pi.sendUserMessage(text)`. */
	sendUserMessage: (text: string) => void | Promise<void>;
	/** Optional UI notifications (message + level). */
	notify?: (message: string, level: "info" | "error") => void;
	/** Optional UI status line updates. */
	setStatus?: (status: string | undefined) => void;
}

export interface MessageModeResult {
	/** The final /kb-dev report. */
	report: string;
	/** The kickoff text (fixed template + message), when delivered. */
	kickoff: string;
	/** Whether the kickoff was delivered to the main agent. */
	delivered: boolean;
}

/**
 * The fixed kickoff template delivered to the main pi agent in message mode
 * (FR-10 step 3, AC-14/AC-15). The main agent interprets the message,
 * identifies the pertinent items, asks the user when unclear, and works the
 * items in DAG order through the standard pipeline.
 */
export function devKickoff(message: string): string {
	return `The user steered this /kb-dev run with the following message; treat it as OPERATIONAL INSTRUCTIONS for working the kb kanban board of this project — not as an idea to plan or spec:

"""
${message}
"""

STEP 1 — INTERPRETATION
Interpret the message as instructions for what to work on now. Inspect the board first: run \`kb list --json\` (and \`kb tree\` if helpful) to see the items, their statuses, titles, descriptions and test states.

STEP 2 — ITEM IDENTIFICATION
Identify the pertinent kb items on the board:
- If the message names items by ID or ref (e.g. "work on KB-42"), use exactly those items.
- Otherwise match the request against the items' titles, descriptions and test states — generic requests must work too (e.g. "fix the broken tests" maps to items with failing or pending tests).
- The message may identify several items; collect them all.

STEP 3 — ASK FIRST WHEN UNCLEAR
If the message is ambiguous, or maps to no item on the board, ask the user for clarification with the \`ask_user\` tool BEFORE touching the board or making any git change. Do not claim, move or modify any item until the pertinent items are confirmed.

STEP 4 — WORK THE ITEMS
Work the identified items in DAG order (respect the board's blockers: run \`kb show <id> --json\` to read \`blocked_by\`; never work an item whose blockers are not done) using the standard pipeline, one item at a time:
- create a task branch per item (branch per task, FR-2: feature/<ID> from develop);
- call the \`kb_agent\` tool with agent "kb-developer" and a complete, self-contained task for the item (same retry policy: retry once on failure);
- when the developer round succeeds, call the \`kb_agent\` tool with agent "kb-reviewer" to review and merge the item (merge chain into develop);
- proceed to the next item only after the previous one is done.

STEP 5 — FINAL REPORT
Finish with a report of every item worked: board status, tests run and their result, and anything the user should look at.`;
}

export async function runMessageDev(deps: MessageModeDeps): Promise<MessageModeResult> {
	const notify = deps.notify ?? (() => {});
	const report: string[] = ["# /kb-dev report — message-steered run", ""];

	// 1. FR-1 pre-flight: a dirty tree aborts before anything else (FR-10
	//    step 1, NFR-8) — no board listing, no review round, no kickoff.
	const pre = await deps.preFlight();
	if (!pre.ok) {
		notify(`${pre.error} Aborting: no action was taken.`, "error");
		report.push(`- pre-flight failed: ${pre.error ?? "unknown error"}`);
		report.push("- aborted before the kickoff was delivered; no board or git action was taken.");
		return { report: report.join("\n"), kickoff: "", delivered: false };
	}

	// 2. Complete the review of items already sitting in the review column —
	//    the same shared sweep as the bare mode (FR-10 step 2, AC-14).
	const swept = await sweepPendingReviews(deps, report);
	if (swept.length) report.push("", `Completed ${swept.length} pending review round(s) before the kickoff.`);

	// 3. Deliver the message as a kickoff to the main pi agent (FR-10 step 3).
	//    Nothing else: item selection and orchestration belong to the main
	//    agent (FR-10 step 4).
	const kickoff = devKickoff(deps.message);
	deps.setStatus?.("delivering kickoff");
	await deps.sendUserMessage(kickoff);
	report.push(`- kickoff delivered to the main agent for the message: "${deps.message}"`);

	return { report: report.join("\n"), kickoff, delivered: true };
}
