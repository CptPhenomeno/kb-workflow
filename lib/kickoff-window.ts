/**
 * The message-mode kickoff window (FR-29, amended 2026-11-14 / KB-61 /
 * AC-38).
 *
 * In message mode the main agent spawns the dev rounds itself, and each
 * kb_agent call would get its own per-call runId, so the /kb-dev run's
 * records could never be aggregated. The kickoff window closes that gap:
 * when the kickoff is delivered, the /kb-dev runId becomes the active
 * kickoff in extension memory; every kb_agent call made while the window
 * is open records with that runId (FR-27 inheritance, see the default in
 * lib/agent-tool.ts); when the agent settles (`pi.on("agent_settled")`,
 * ctx.isIdle() true), the extension emits the "Usage this run" block for
 * the window's records — sweep plus kickoff rounds alike — through the
 * TUI-only channel (FR-30) and closes the window.
 *
 * The window is extension memory only: an extension reload loses it, so
 * rounds fall back to per-call ids and no block is emitted (acceptable
 * degradation). /kb-dev requires an idle agent, so windows never overlap.
 *
 * Pure Node builtins, no pi imports (NFR-17): the state and the settle
 * seam are unit-testable in isolation; index.ts wires them to pi.
 */

import { renderRunUsageBlock } from "./cost-report.ts";
import { ledgerPathFor } from "./round-ledger.ts";
import { appendUsageEntry, type AppendEntry } from "./usage-entry.ts";
import { readRecords } from "./usage-ledger.ts";

/** The active kickoff window: the runId of the delivered /kb-dev run. */
let activeKickoff: string | null = null;

/**
 * Open the kickoff window: record the /kb-dev `runId` as the active kickoff
 * in extension memory (FR-29). Called when the message-mode kickoff is
 * delivered; /kb-dev requires an idle agent, so windows never overlap.
 */
export function openKickoffWindow(runId: string): void {
	activeKickoff = runId;
}

/** The runId of the open kickoff window, null when none is open. */
export function activeKickoffRunId(): string | null {
	return activeKickoff;
}

/**
 * Close the kickoff window. Returns the closed window's runId, or null when
 * no window was open.
 */
export function closeKickoffWindow(): string | null {
	const runId = activeKickoff;
	activeKickoff = null;
	return runId;
}

/** Dependencies of the settle seam, injectable for tests. */
export interface SettleKickoffDeps {
	/** The project root; the ledger sits in `<cwd>/.pi/kb-usage.jsonl`. */
	cwd: string;
	/** The extension's `pi.appendEntry` seam (the TUI-only channel). */
	appendEntry: AppendEntry;
}

/**
 * Settle the kickoff window (FR-29 / AC-38): close it and emit the
 * "Usage this run" block for its records — every ledger record carrying
 * the window's runId, sweep plus kickoff rounds alike — through the
 * TUI-only channel. A window that recorded no rounds emits no block; no
 * open window is a no-op (e.g. after an extension reload). An unreadable
 * ledger degrades to an empty record set (NFR-15).
 */
export function settleKickoffWindow(deps: SettleKickoffDeps): void {
	const runId = closeKickoffWindow();
	if (runId === null) return;
	const records = readRecords(ledgerPathFor(deps.cwd)).filter((record) => record.runId === runId);
	if (records.length === 0) return;
	appendUsageEntry(deps.appendEntry, renderRunUsageBlock(records));
}
