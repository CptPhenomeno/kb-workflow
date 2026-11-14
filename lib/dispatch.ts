/**
 * Argument parsing and mode dispatch for the /kb-dev command (FR-10 / FR-11).
 *
 * The dispatchers no longer live in `index.ts`: this module wires both mode
 * runners from the seams injected by `index.ts` (subagent runner, kb, config).
 * `parseDevArgs` decides the retrieval mode from the raw command arguments;
 * `dispatchDev` hands the run to exactly one mode runner. Every subagent
 * round — bare mode and message mode alike — resolves the per-role config
 * with `resolveAgentConfig` (FR-20) and forwards both the model and the
 * thinking level to the subagent runner (FR-21). The bare runner resolves
 * the next unit via the FR-11 chain (epic-scoped story -> board-wide story
 * -> single task/bug) and works one story per invocation; the message runner
 * builds the fixed kickoff template (FR-10).
 *
 * Every round spawned through this module — dev, reviewer and qa, bare and
 * message mode alike — is also persisted to the usage ledger with one entry
 * per round, successful or failed (FR-28), best-effort so a ledger failure
 * never fails the round or the run (NFR-15). The "Usage this run" block of
 * FR-29 (amended 2026-11-14) is delivered per mode: bare mode appends it to
 * the final report, aggregated from this run's ledger records; message mode
 * opens the kickoff window instead (lib/kickoff-window.ts) so the block is
 * emitted when the kickoff run settles.
 */

import type { KbWorkflowConfig, SessionFallbacks } from "./config.ts";
import type { SubagentRunOptions } from "./agent-tool.ts";
import { runBareDev, type AgentRoundResult, type BareModeDeps } from "./bare-mode.ts";
import { runMessageDev, type MessageModeDeps } from "./message-mode.ts";
import { devTask, qaTask, reviewTask } from "./prompts.ts";
import type { KbItem, KbRun } from "./kb.ts";
import { renderRunUsageBlock } from "./cost-report.ts";
import { openKickoffWindow } from "./kickoff-window.ts";
import { readRecords } from "./usage-ledger.ts";
import { ledgerPathFor, newRunId, recordRound } from "./round-ledger.ts";

export type DevMode = { mode: "bare"; message: null } | { mode: "message"; message: string };

/** Parse the raw `/kb-dev` arguments into the retrieval mode. */
export function parseDevArgs(args: string): DevMode {
	const message = args.trim();
	if (!message) return { mode: "bare", message: null };
	return { mode: "message", message };
}

/** The seams `index.ts` injects into the dispatchers. */
export interface DispatchDeps {
	/** Raw command arguments as received by the handler. */
	args: string;
	cwd: string;
	/** Parsed kb-workflow config for the per-role resolution (FR-20). */
	config?: KbWorkflowConfig;
	/** The dispatching session's model and thinking level (fallbacks, FR-20). */
	session?: SessionFallbacks;
	/** Stands in for `runKb(args, cwd)`. */
	kb: (args: string[]) => Promise<KbRun>;
	/** Stands in for `preFlightCheck(cwd)` (FR-1, message mode). */
	preFlight: () => Promise<{ ok: boolean; error?: string; branch?: string }>;
	/** The subagent runner seam: receives the agent, the task and both resolved properties (FR-21). */
	runSubagent: (opts: SubagentRunOptions) => Promise<AgentRoundResult>;
	/** Stands in for `pi.sendUserMessage(text)` (message mode). */
	sendUserMessage: (text: string) => void | Promise<void>;
	/** Optional UI notifications (message + level). */
	notify?: (message: string, level: "info" | "error") => void;
	/** Optional UI status line updates. */
	setStatus?: (status: string | undefined) => void;
	/** Overrides the ledger location (defaults to `<cwd>/.pi/kb-usage.jsonl`, FR-27). */
	ledgerPath?: string;
	/** Overrides the run id identifying this invocation in the ledger (FR-27). */
	runId?: string;
}

/**
 * Dispatch one /kb-dev invocation to the mode selected by the arguments.
 * Exactly one runner is invoked, exactly once. Every spawn resolves the
 * per-role model and thinking level (FR-20) and forwards both properties
 * to the subagent runner (FR-21).
 */
export async function dispatchDev(deps: DispatchDeps): Promise<{ report: string; delivered?: boolean }> {
	const parsed = parseDevArgs(deps.args);

	// One run id per /kb-dev invocation, one ledger location (FR-27): every
	// round of this run — bare and message mode alike — is recorded under it.
	const runId = deps.runId ?? newRunId("kb-dev");
	const ledgerPath = deps.ledgerPath ?? ledgerPathFor(deps.cwd);

	// Per-role resolution: the mode runners call resolveAgentConfig for each
	// role (FR-20) and hand the resolved properties to these seams, which
	// forward both of them to the subagent runner (FR-21) and persist one
	// ledger entry per round, successful or failed (FR-28, best-effort per
	// NFR-15 — a ledger failure never fails the round or the run).
	const run = async (
		agent: SubagentRunOptions["agent"],
		item: string | null,
		task: string,
		resolved: { model?: string; thinkingLevel?: string },
	): Promise<AgentRoundResult> => {
		const result = await deps.runSubagent({ agent, task, model: resolved.model, thinkingLevel: resolved.thinkingLevel });
		// FR-25: the round result carries the resolved model, thinking level
		// and usage of the round, from the same resolution that built the
		// spawn args above — so every reportRound line can name them (AC-32)
		// and the usage reaches the ledger (FR-28). `usage` rides along from
		// the subagent runner's SubagentResult; a property that resolved to
		// nothing stays undefined and reads "unknown" in the report.
		const round: AgentRoundResult = {
			...result,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			usage: result.usage,
		};
		recordRound(ledgerPath, { runId, agent, item, resolved, result: round });
		return round;
	};

	// Resolve the parent story of a task for its dev prompt (best effort).
	const storyCache = new Map<string, KbItem | null>();
	const storyOf = async (task: KbItem): Promise<KbItem | null> => {
		if (!task.parent) return null;
		if (storyCache.has(task.parent)) return storyCache.get(task.parent) ?? null;
		const res = await deps.kb(["show", task.parent]);
		const story = (res.code === 0 ? res.json : undefined) as KbItem | undefined;
		storyCache.set(task.parent, story ?? null);
		return story ?? null;
	};

	const spawnReviewer = (item: KbItem, resolved: { model?: string; thinkingLevel?: string }) =>
		run("kb-reviewer", item.id, reviewTask(item), resolved);
	const spawnQa = (item: KbItem, resolved: { model?: string; thinkingLevel?: string }) =>
		run("kb-qa", item.id, qaTask(item), resolved);
	const spawnDev = async (task: KbItem, resolved: { model?: string; thinkingLevel?: string }) =>
		run("kb-developer", task.id, devTask(task, await storyOf(task)), resolved);

	// FR-29 (amended 2026-11-14): the "Usage this run" block is delivered
	// per mode. Bare mode: the block lands at the end of the final report,
	// aggregating this run's ledger records by runId (all rounds pass
	// through the dispatch seam); a ledger that cannot be read degrades to
	// an empty record set (NFR-15).
	const withUsage = (report: string): string =>
		`${report}\n\n${renderRunUsageBlock(readRecords(ledgerPath).filter((record) => record.runId === runId))}`;

	if (parsed.mode === "message") {
		const result = await runMessageDev({
			cwd: deps.cwd,
			message: parsed.message,
			kb: deps.kb,
			config: deps.config,
			session: deps.session,
			preFlight: deps.preFlight,
			spawnReviewer,
			spawnQa,
			sendUserMessage: deps.sendUserMessage,
			notify: deps.notify,
			setStatus: deps.setStatus,
		});
		// Message mode: the delivered kickoff opens the kickoff window
		// (FR-29, AC-38) — the /kb-dev runId becomes the active kickoff, the
		// kb_agent calls the main agent spawns inherit it (FR-27), and the
		// block is emitted when the kickoff run settles (lib/kickoff-window.ts),
		// not in this report. An aborted run delivers no kickoff and opens
		// no window; /kb-dev requires an idle agent, so windows never overlap.
		if (result.delivered) openKickoffWindow(runId);
		return { report: result.report, delivered: result.delivered };
	}
	const result = await runBareDev({
		cwd: deps.cwd,
		kb: deps.kb,
		config: deps.config,
		session: deps.session,
		spawnDev,
		spawnReviewer,
		spawnQa,
		notify: deps.notify,
		setStatus: deps.setStatus,
	});
	return { report: withUsage(result.report) };
}
