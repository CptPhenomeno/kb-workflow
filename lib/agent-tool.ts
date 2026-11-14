/**
 * Resolution + invocation seam for the `kb_agent` tool.
 *
 * The tool resolves the per-role config (model and thinking level, each
 * falling back independently to the dispatching session's values, FR-20)
 * and forwards both properties to the subagent runner (FR-21). Kept out of
 * `index.ts` so the behavior is unit-testable without a pi session.
 */

import { resolveAgentConfig, type AgentRole, type KbWorkflowConfig, type RoleConfig, type SessionFallbacks } from "./config.ts";
import type { KbAgentName, SubagentResult, SubagentUsage } from "./subagent.ts";
import { activeKickoffRunId } from "./kickoff-window.ts";
import { itemFromTask, newRunId, recordRound } from "./round-ledger.ts";

/**
 * pi's `Usage` shape (pi-ai), as far as this extension constructs it: the
 * structural contract pi's accounting reads — `cost` is the cost object pi
 * expects, with `total` (FR-31). The optional splits pi adds
 * (`cacheWrite1h`, `reasoning`, `cost.totalFromProvider`) are simply absent.
 */
export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/**
 * Convert the internal flat `SubagentUsage` to pi's `Usage` shape (FR-31):
 * the subagent runner only knows the round's total cost, so it lands in
 * `cost.total` — the field pi's session accounting reads — while the
 * per-channel cost splits stay zero.
 */
export function toPiUsage(usage: SubagentUsage): PiUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

/** The complete kb_agent tool result (FR-31): content for the model,
 * `details` for the rendering, `usage` for pi's session totals. */
export interface KbAgentToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		ok: boolean;
		agent: KbAgentName;
		actor: string;
		exitCode: number | null;
		/** The internal flat usage, kept for the rendering (turns included). */
		usage: SubagentUsage;
		/** The resolved model of the round, for the custom rendering (FR-24). */
		model?: string;
		/** The resolved thinking level of the round, for the custom rendering (FR-24). */
		thinkingLevel?: string;
		/** Every streamed assistant text of the round, in order (FR-24). */
		lines?: string[];
	};
	/** The round's usage in pi's `Usage` shape, so pi counts the subagent spend. */
	usage: PiUsage;
}

/** The round info the final tool result carries for the rendering (FR-24):
 * the resolved config and the streamed lines of the round. */
export interface KbAgentRoundInfo {
	resolved?: RoleConfig;
	lines?: string[];
}

/**
 * Build the kb_agent tool result from a subagent outcome: the model-facing
 * text (header, output, stderr), the rendering `details` and — new in FR-31 —
 * the round's usage in pi's `Usage` shape on the field pi accounts a tool's
 * spend from, so the footer, `/session` and RPC session totals include the
 * subagent spend.
 */
export function kbAgentToolResult(res: SubagentResult, round?: KbAgentRoundInfo): KbAgentToolResult {
	const header = res.ok
		? `Subagent ${res.agent} completed.`
		: `Subagent ${res.agent} FAILED (exit ${res.exitCode}${res.errorMessage ? `: ${res.errorMessage}` : ""}).`;
	const stderr = res.stderr.trim();
	// FR-24: the final `details` carry the resolved config and the streamed
	// lines so the custom rendering — and a reload, which replays no partial —
	// can draw the variant A title line and result. The keys are added only
	// when the round info provides them (an old caller without it keeps the
	// FR-31 shape).
	const details: KbAgentToolResult["details"] = { ok: res.ok, agent: res.agent, actor: res.actor, exitCode: res.exitCode, usage: res.usage };
	if (round?.resolved?.model !== undefined) details.model = round.resolved.model;
	if (round?.resolved?.thinkingLevel !== undefined) details.thinkingLevel = round.resolved.thinkingLevel;
	if (round?.lines !== undefined) details.lines = round.lines;
	return {
		content: [{ type: "text", text: `${header}\n\n${res.output}${stderr ? `\n\nstderr:\n${stderr}` : ""}` }],
		details,
		usage: toPiUsage(res.usage),
	};
}

/** The partial tool result streamed while the subagent runs (FR-23):
 * `content` is the running line plus the subagent's text so far,
 * `details` carries the resolved config so even the default rendering
 * shows what the round runs with. */
export interface KbAgentUpdate {
	content: Array<{ type: "text"; text: string }>;
	details: {
		agent: KbAgentName;
		running: boolean;
		model?: string;
		thinkingLevel?: string;
	};
}

/**
 * The running line of the streamed text (FR-23): `<agent> running ·
 * <model> · thinking <level>`, the running call of the validated prototype
 * (variant A). Missing resolved values are omitted rather than rendered
 * as `undefined`.
 */
export function kbAgentRunningLine(agent: KbAgentName, resolved: RoleConfig): string {
	const parts = [`${agent} running`];
	if (resolved.model !== undefined) parts.push(resolved.model);
	if (resolved.thinkingLevel !== undefined) parts.push(`thinking ${resolved.thinkingLevel}`);
	return parts.join(" · ");
}

/**
 * Build one streamed update (FR-23): the running line (resolved model and
 * thinking level) followed by the subagent's text so far, and `details`
 * carrying the same resolved values on every update — not only the first.
 */
export function kbAgentUpdate(agent: KbAgentName, resolved: RoleConfig, text: string): KbAgentUpdate {
	return {
		content: [{ type: "text", text: `${kbAgentRunningLine(agent, resolved)}\n${text}` }],
		details: { agent, running: true, model: resolved.model, thinkingLevel: resolved.thinkingLevel },
	};
}

/** Map a subagent name to its config role (`kb-developer` -> `developer`). */
export const roleOf = (agent: KbAgentName): AgentRole => agent.replace("kb-", "") as AgentRole;

/** Options forwarded to the subagent runner (the slice runSubagent needs). */
export interface SubagentRunOptions {
	agent: KbAgentName;
	task: string;
	model?: string;
	thinkingLevel?: string;
}

export interface KbAgentToolDeps {
	agent: KbAgentName;
	task: string;
	/** Parsed kb-workflow config (extension folder merged with project). */
	config: KbWorkflowConfig;
	/** The dispatching session's model and thinking level (fallbacks, FR-20). */
	session: SessionFallbacks;
	/** The subagent runner seam (stands in for `runSubagent`). */
	runSubagent: (opts: SubagentRunOptions) => Promise<SubagentResult>;
	signal?: AbortSignal;
	/** Receives every streamed update, already carrying the resolved config (FR-23). */
	onUpdate?: (update: KbAgentUpdate) => void;
	/** Ledger location (FR-27); when set, the invocation is persisted (FR-28). */
	ledgerPath?: string;
	/**
	 * Identifies this invocation's run in the ledger: an explicit id wins;
	 * otherwise the call inherits the open kickoff window's runId (FR-27/
	 * FR-29, AC-38) and only with no window open gets a fresh per-call id.
	 */
	runId?: string;
}

/** One kb_agent execution, with everything the final tool result's
 * rendering needs (FR-24): the round's `SubagentResult`, the resolved
 * config it ran with, and every streamed assistant text in order. */
export interface KbAgentExecution {
	result: SubagentResult;
	resolved: RoleConfig;
	lines: string[];
}

/**
 * Run one kb_agent tool invocation: resolve both properties for the role
 * and hand them, together with the agent name and task, to the runner.
 * The returned execution feeds `kbAgentToolResult` for the tool's final
 * result: the `SubagentResult` plus the resolved config and the streamed
 * lines of the round (FR-24).
 */
export async function executeKbAgent(deps: KbAgentToolDeps): Promise<KbAgentExecution> {
	const resolved = resolveAgentConfig(roleOf(deps.agent), deps.config, deps.session);
	// FR-24: every streamed assistant text of the round, in order — the
	// lines the custom rendering shows (all expanded, last two collapsed).
	const lines: string[] = [];
	const result = await deps.runSubagent({
		agent: deps.agent,
		task: deps.task,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel,
		signal: deps.signal,
		// FR-23: every streamed update carries the resolved model and thinking
		// level — in the running line of the text and in `details` — so the
		// default rendering shows them even without a custom renderer. The
		// wrapper is always installed: it accumulates the streamed lines for
		// the final result's rendering (FR-24) even without an onUpdate consumer.
		onUpdate: (t) => {
			lines.push(t);
			deps.onUpdate?.(kbAgentUpdate(deps.agent, resolved, t));
		},
	});
	// FR-28: every kb_agent invocation is persisted to the usage ledger,
	// successful or failed, best-effort (NFR-15): a ledger failure never
	// fails the round. `item` is the kb item ID the task targets, null when
	// it targets none. `runId` identifies the invocation's run: an explicit
	// one wins; otherwise the call inherits the runId of the open kickoff
	// window (FR-27/FR-29, AC-38), and only with no window open does it get
	// its own per-call id.
	if (deps.ledgerPath) {
		recordRound(deps.ledgerPath, {
			runId: deps.runId ?? activeKickoffRunId() ?? newRunId("kb-agent"),
			agent: deps.agent,
			item: itemFromTask(deps.task),
			resolved,
			result,
		});
	}
	return { result, resolved, lines };
}
