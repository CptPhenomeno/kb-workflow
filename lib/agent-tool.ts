/**
 * Resolution + invocation seam for the `kb_agent` tool.
 *
 * The tool resolves the per-role config (model and thinking level, each
 * falling back independently to the dispatching session's values, FR-20)
 * and forwards both properties to the subagent runner (FR-21). Kept out of
 * `index.ts` so the behavior is unit-testable without a pi session.
 */

import { resolveAgentConfig, type AgentRole, type KbWorkflowConfig, type SessionFallbacks } from "./config.ts";
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
	};
	/** The round's usage in pi's `Usage` shape, so pi counts the subagent spend. */
	usage: PiUsage;
}

/**
 * Build the kb_agent tool result from a subagent outcome: the model-facing
 * text (header, output, stderr), the rendering `details` and — new in FR-31 —
 * the round's usage in pi's `Usage` shape on the field pi accounts a tool's
 * spend from, so the footer, `/session` and RPC session totals include the
 * subagent spend.
 */
export function kbAgentToolResult(res: SubagentResult): KbAgentToolResult {
	const header = res.ok
		? `Subagent ${res.agent} completed.`
		: `Subagent ${res.agent} FAILED (exit ${res.exitCode}${res.errorMessage ? `: ${res.errorMessage}` : ""}).`;
	const stderr = res.stderr.trim();
	return {
		content: [{ type: "text", text: `${header}\n\n${res.output}${stderr ? `\n\nstderr:\n${stderr}` : ""}` }],
		details: { ok: res.ok, agent: res.agent, actor: res.actor, exitCode: res.exitCode, usage: res.usage },
		usage: toPiUsage(res.usage),
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
	onUpdate?: (text: string) => void;
	/** Ledger location (FR-27); when set, the invocation is persisted (FR-28). */
	ledgerPath?: string;
	/**
	 * Identifies this invocation's run in the ledger: an explicit id wins;
	 * otherwise the call inherits the open kickoff window's runId (FR-27/
	 * FR-29, AC-38) and only with no window open gets a fresh per-call id.
	 */
	runId?: string;
}

/**
 * Run one kb_agent tool invocation: resolve both properties for the role
 * and hand them, together with the agent name and task, to the runner.
 * The returned `SubagentResult` feeds `kbAgentToolResult` for the tool's
 * final result.
 */
export async function executeKbAgent(deps: KbAgentToolDeps): Promise<SubagentResult> {
	const resolved = resolveAgentConfig(roleOf(deps.agent), deps.config, deps.session);
	const result = await deps.runSubagent({
		agent: deps.agent,
		task: deps.task,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel,
		signal: deps.signal,
		onUpdate: deps.onUpdate,
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
	return result;
}
