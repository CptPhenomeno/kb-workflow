import assert from "node:assert/strict";
import { test } from "node:test";

import { executeKbAgent } from "./agent-tool.ts";
import type { KbWorkflowConfig } from "./config.ts";
import type { KbAgentName, SubagentResult } from "./subagent.ts";

function config(partial: KbWorkflowConfig): KbWorkflowConfig {
	return partial;
}

function result(agent: KbAgentName, opts: { model?: string; thinkingLevel?: string }): SubagentResult {
	return {
		ok: true,
		agent,
		actor: "agent-test",
		output: `ran ${agent} model=${opts.model ?? "-"} thinking=${opts.thinkingLevel ?? "-"}`,
		stderr: "",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
	};
}

test("kb_agent tool resolves and forwards model and thinking-level per role", async () => {
	const seen: Array<{ agent: KbAgentName; model?: string; thinkingLevel?: string }> = [];
	await executeKbAgent({
		agent: "kb-developer",
		task: "implement KB-8",
		config: config({
			kbAgents: {
				developer: { model: "provider/dev", thinkingLevel: "high" },
			},
		}),
		session: { model: "provider/session", thinkingLevel: "medium" },
		runSubagent: async (opts) => {
			seen.push({ agent: opts.agent, model: opts.model, thinkingLevel: opts.thinkingLevel });
			return result(opts.agent, opts);
		},
	});
	assert.deepEqual(seen, [
		{ agent: "kb-developer", model: "provider/dev", thinkingLevel: "high" },
	]);
});

test("kb_agent tool forwards the resolved model and thinking level", async () => {
	// Unset properties fall back independently to the session's values.
	const seen: Array<{ model?: string; thinkingLevel?: string }> = [];
	await executeKbAgent({
		agent: "kb-reviewer",
		task: "review KB-8",
		config: config({ kbAgents: { reviewer: { model: "provider/rev" } } }),
		session: { model: "provider/session", thinkingLevel: "low" },
		runSubagent: async (opts) => {
			seen.push({ model: opts.model, thinkingLevel: opts.thinkingLevel });
			return result(opts.agent, opts);
		},
	});
	assert.deepEqual(seen, [{ model: "provider/rev", thinkingLevel: "low" }]);
});
