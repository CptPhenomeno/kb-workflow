/**
 * Resolution + invocation seam for the `kb_agent` tool.
 *
 * The tool resolves the per-role config (model and thinking level, each
 * falling back independently to the dispatching session's values, FR-20)
 * and forwards both properties to the subagent runner (FR-21). Kept out of
 * `index.ts` so the behavior is unit-testable without a pi session.
 */

import { resolveAgentConfig, type AgentRole, type KbWorkflowConfig, type SessionFallbacks } from "./config.ts";
import type { KbAgentName, SubagentResult } from "./subagent.ts";
import { itemFromTask, newRunId, recordRound } from "./round-ledger.ts";

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
	/** Identifies this kb_agent invocation in the ledger (default: a fresh id). */
	runId?: string;
}

/**
 * Run one kb_agent tool invocation: resolve both properties for the role
 * and hand them, together with the agent name and task, to the runner.
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
	// it targets none; `runId` identifies this individual call.
	if (deps.ledgerPath) {
		recordRound(deps.ledgerPath, {
			runId: deps.runId ?? newRunId("kb-agent"),
			agent: deps.agent,
			item: itemFromTask(deps.task),
			resolved,
			result,
		});
	}
	return result;
}
