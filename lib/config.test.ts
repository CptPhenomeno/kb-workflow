import assert from "node:assert/strict";
import { test } from "node:test";
import {
	mergeKbAgents,
	parseKbAgents,
	parseThinkingLevel,
	resolveAgentConfig,
	resolveAgentModel,
	type SessionFallbacks,
	type AgentRole,
	type KbWorkflowConfig,
} from "./config.ts";

const roles: AgentRole[] = ["planner", "developer", "reviewer", "qa"];

const session: SessionFallbacks = { model: "session/model", thinkingLevel: "medium" };

// resolveAgentConfig — per-role resolution with independent fallbacks (KB-5, FR-20)

test("fully absent role resolves to unset model and unset thinking-level", () => {
	const resolved = resolveAgentConfig("planner", {}, {});
	assert.equal(resolved.model, undefined);
	assert.equal(resolved.thinkingLevel, undefined);
});

test("role with only model resolves to that model and the session thinking level", () => {
	const config: KbWorkflowConfig = { kbAgents: { developer: { model: "d/m" } } };
	const resolved = resolveAgentConfig("developer", config, session);
	assert.deepEqual(resolved, { model: "d/m", thinkingLevel: "medium" }); // AC-27
});

test("role absent from the config resolves to the session model and thinking level", () => {
	const resolved = resolveAgentConfig("reviewer", {}, session);
	assert.deepEqual(resolved, { model: "session/model", thinkingLevel: "medium" }); // AC-28
});

test("role with an unknown thinking-level resolves to the session thinking level", () => {
	// invalid levels are dropped at parse time (FR-19), so the fallback applies
	const parsed = parseKbAgents({ "kb-agents": { qa: { model: "q/m", "thinking-level": "banana" } } });
	const resolved = resolveAgentConfig("qa", { kbAgents: parsed }, session);
	assert.deepEqual(resolved, { model: "q/m", thinkingLevel: "medium" });
});

test("qa role resolves model and thinking-level like planner, developer and reviewer", () => {
	const config: KbWorkflowConfig = {
		kbAgents: {
			planner: { model: "p/m", thinkingLevel: "high" },
			developer: { model: "d/m" },
			reviewer: { thinkingLevel: "low" },
			qa: { model: "q/m", thinkingLevel: "low" },
		},
	};
	for (const role of roles) {
		const resolved = resolveAgentConfig(role, config, session);
		assert.equal(resolved.model, config.kbAgents![role]!.model ?? session.model);
		assert.equal(resolved.thinkingLevel, config.kbAgents![role]!.thinkingLevel ?? session.thinkingLevel);
	} // AC-29
});

test("kb-agents config parses model and thinking-level for all four roles including qa", () => {
	const parsed = parseKbAgents({
		"kb-agents": {
			planner: { model: "anthropic/claude-sonnet-4-5", "thinking-level": "high" },
			developer: { model: "anthropic/claude-haiku-4-5", "thinking-level": "medium" },
			reviewer: { model: "anthropic/claude-sonnet-4-5", "thinking-level": "low" },
			qa: { model: "anthropic/claude-sonnet-4-5", "thinking-level": "low" },
		},
	});
	for (const role of roles) {
		assert.ok(parsed[role], `${role} must be present`);
	}
	assert.equal(parsed.qa?.model, "anthropic/claude-sonnet-4-5");
	assert.equal(parsed.qa?.thinkingLevel, "low");
	assert.equal(parsed.planner?.thinkingLevel, "high");
	assert.equal(parsed.developer?.thinkingLevel, "medium");
	assert.equal(parsed.reviewer?.thinkingLevel, "low");
});

test("role object with only model or only thinking-level parses without error", () => {
	const parsed = parseKbAgents({
		"kb-agents": {
			planner: { model: "p/m" },
			developer: { "thinking-level": "max" },
			reviewer: {},
		},
	});
	assert.deepEqual(parsed.planner, { model: "p/m" });
	assert.deepEqual(parsed.developer, { thinkingLevel: "max" });
	assert.equal(parsed.reviewer, undefined);
});

test("old models-format config yields no kb-agents entries", () => {
	const oldFormat = {
		models: { planner: "anthropic/claude-sonnet-4-5", developer: "x/y", reviewer: "x/y", qa: "x/y" },
	};
	assert.deepEqual(parseKbAgents(oldFormat), {});
	assert.deepEqual(parseKbAgents({ models: {} }), {});
	// no kb-agents key at all
	assert.deepEqual(parseKbAgents({}), {});
});

test("unknown thinking-level is dropped and treated as unset", () => {
	assert.equal(parseThinkingLevel("ultra"), undefined);
	assert.equal(parseThinkingLevel(42), undefined);
	assert.deepEqual(
		parseKbAgents({ "kb-agents": { qa: { model: "q/m", "thinking-level": "ultra" } } }),
		{ qa: { model: "q/m" } },
	);
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.equal(parseThinkingLevel(level), level);
	}
});

test("malformed or non-object config never throws", () => {
	for (const bad of [undefined, null, "nope", 42, [], { "kb-agents": "nope" }, { "kb-agents": [] }, { "kb-agents": { planner: "just-a-string" } }, { "kb-agents": { planner: { model: 5 } } }]) {
		assert.doesNotThrow(() => parseKbAgents(bad));
		assert.deepEqual(parseKbAgents(bad), {});
	}
});

test("new-format config resolves model and thinking-level per role", () => {
	const config: KbWorkflowConfig = {
		kbAgents: parseKbAgents({
			"kb-agents": {
				developer: { model: "d/m", "thinking-level": "medium" },
				qa: { model: "q/m" },
			},
		}),
	};
	assert.equal(resolveAgentModel("developer", config, "session/m"), "d/m");
	assert.equal(resolveAgentModel("qa", config, "session/m"), "q/m");
	assert.equal(resolveAgentModel("planner", config, "session/m"), "session/m");

	// While the old models shape is still loaded by config-load.ts (until
	// KB-5), resolveAgentModel keeps honoring it so the runtime keeps working.
	assert.equal(resolveAgentModel("reviewer", { models: { reviewer: "old/m" } }, "s/m"), "old/m");
});

test("role takes model from global and thinking-level from project when each defines only one", () => {
	const global = parseKbAgents({ "kb-agents": { planner: { model: "g/planner" } } });
	const project = parseKbAgents({ "kb-agents": { planner: { "thinking-level": "high" } } });
	const merged = mergeKbAgents(global, project);
	assert.equal(merged.planner?.model, "g/planner");
	assert.equal(merged.planner?.thinkingLevel, "high");
});

test("role takes model from project and thinking-level from global when each defines only one", () => {
	const global = parseKbAgents({ "kb-agents": { qa: { "thinking-level": "low" } } });
	const project = parseKbAgents({ "kb-agents": { qa: { model: "p/qa" } } });
	const merged = mergeKbAgents(global, project);
	assert.equal(merged.qa?.model, "p/qa");
	assert.equal(merged.qa?.thinkingLevel, "low");
});

test("merge covers all four roles and project wins per property", () => {
	const global = parseKbAgents({
		"kb-agents": {
			planner: { model: "g/planner", "thinking-level": "high" },
			developer: { model: "g/dev", "thinking-level": "medium" },
			reviewer: { model: "g/reviewer", "thinking-level": "low" },
			qa: { model: "g/qa", "thinking-level": "low" },
		},
	});
	const project = parseKbAgents({
		"kb-agents": {
			planner: { model: "p/planner" },
			developer: { "thinking-level": "high" },
		},
	});
	const merged = mergeKbAgents(global, project);
	assert.equal(merged.planner?.model, "p/planner"); // project overrides the same property
	assert.equal(merged.planner?.thinkingLevel, "high"); // untouched property survives
	assert.equal(merged.developer?.model, "g/dev");
	assert.equal(merged.developer?.thinkingLevel, "high");
	assert.deepEqual(merged.reviewer, { model: "g/reviewer", thinkingLevel: "low" });
	assert.deepEqual(merged.qa, { model: "g/qa", thinkingLevel: "low" });
});
