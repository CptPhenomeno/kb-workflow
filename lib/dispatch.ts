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
 */

import type { KbWorkflowConfig, SessionFallbacks } from "./config.ts";
import type { SubagentRunOptions } from "./agent-tool.ts";
import { runBareDev, type AgentRoundResult, type BareModeDeps } from "./bare-mode.ts";
import { runMessageDev, type MessageModeDeps } from "./message-mode.ts";
import { devTask, qaTask, reviewTask } from "./prompts.ts";
import type { KbItem, KbRun } from "./kb.ts";

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
}

/**
 * Dispatch one /kb-dev invocation to the mode selected by the arguments.
 * Exactly one runner is invoked, exactly once. Every spawn resolves the
 * per-role model and thinking level (FR-20) and forwards both properties
 * to the subagent runner (FR-21).
 */
export async function dispatchDev(deps: DispatchDeps): Promise<{ report: string; delivered?: boolean }> {
	const parsed = parseDevArgs(deps.args);

	// Per-role resolution: the mode runners call resolveAgentConfig for each
	// role (FR-20) and hand the resolved properties to these seams, which
	// forward both of them to the subagent runner (FR-21).
	const run = (
		agent: SubagentRunOptions["agent"],
		task: string,
		resolved: { model?: string; thinkingLevel?: string },
	): Promise<AgentRoundResult> =>
		deps.runSubagent({ agent, task, model: resolved.model, thinkingLevel: resolved.thinkingLevel });

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
		run("kb-reviewer", reviewTask(item), resolved);
	const spawnQa = (item: KbItem, resolved: { model?: string; thinkingLevel?: string }) =>
		run("kb-qa", qaTask(item), resolved);
	const spawnDev = async (task: KbItem, resolved: { model?: string; thinkingLevel?: string }) =>
		run("kb-developer", devTask(task, await storyOf(task)), resolved);

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
	return { report: result.report };
}
