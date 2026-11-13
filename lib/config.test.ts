import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentModel, type AgentRole, type KbWorkflowConfig } from "./config.ts";

const roles: AgentRole[] = ["planner", "developer", "reviewer", "qa"];

test("models.qa resolves with fallback to the session model", () => {
	const config: KbWorkflowConfig = { models: { qa: "provider/qa-model" } };
	assert.equal(resolveAgentModel("qa", config, "session/model"), "provider/qa-model");
	assert.equal(resolveAgentModel("qa", {}, "session/model"), "session/model");
	assert.equal(resolveAgentModel("qa", { models: { planner: "p/m" } }), undefined);

	// qa is a first-class role alongside the others
	assert.deepEqual(
		roles.filter((r) => r === "qa"),
		["qa"],
	);
});
