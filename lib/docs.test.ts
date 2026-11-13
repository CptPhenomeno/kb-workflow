import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseKbAgents } from "./config.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const indexTs = fs.readFileSync(path.join(root, "index.ts"), "utf8");
const example = JSON.parse(fs.readFileSync(path.join(root, "kb-workflow.example.json"), "utf8"));
const repoConfig = JSON.parse(fs.readFileSync(path.join(root, "kb-workflow.json"), "utf8"));

const ROLES = ["planner", "developer", "reviewer", "qa"];

test("README Model configuration section documents kb-agents with model and thinking-level", () => {
	const section = readme.slice(readme.indexOf("## Model configuration"));
	assert.ok(section.includes("kb-agents"), "README documents the kb-agbons shape");
	assert.ok(section.includes("model"), "README documents the model property");
	assert.ok(section.includes("thinking-level"), "README documents the thinking-level property");
	assert.ok(section.includes(".pi/kb-workflow.json"), "README documents the project-local location");
	assert.ok(
		/off\|minimal\|low\|medium\|high\|xhigh\|max|off, minimal, low, medium, high, xhigh, max|`off`|`minimal`/.test(section),
		"README documents the allowed thinking levels",
	);
	assert.ok(
	/models/.test(section) && /no longer supported/.test(section),
		"README states the old models format is no longer supported",
	);
});

test("README Model configuration section documents kb-agents with model and thinking-level for all four roles", () => {
	const section = readme.slice(readme.indexOf("## Model configuration"));
	for (const role of ROLES) {
		assert.ok(section.includes(role), `README documents the ${role} role`);
	}
	assert.ok(
		/fallback|inherits/i.test(section),
		"README documents the fallback rules",
	);
});

test("kb-workflow.example.json uses the kb-agents format", () => {
	const parsed = parseKbAgents(example);
	for (const role of ROLES) {
		assert.ok(parsed[role as keyof typeof parsed], `example config covers the ${role} role`);
	}
});

test("repo kb-work.json uses the kb-agents format", () => {
	const parsed = parseKbAgents(repoConfig);
	for (const role of ROLES) {
		assert.ok(parsed[role as keyof typeof parsed], `repo config covers the ${role} role`);
	}
});

test("example and repo config files use the kb-agents format", () => {
	assert.ok("kb-agents" in example, "example config has a kb-agents key");
	assert.ok(!("models" in example), "example config has no models key");
	assert.ok("kb-agents" in repoConfig, "repo config has a kb-agents key");
	assert.ok(!("models" in repoConfig), "repo config has no models key");
});

test("no shipped config file still uses the models key", () => {
	assert.ok(!indexTs.includes('"models"'), "index.ts header does not document the models format");
	assert.ok(!("models" in example) && !("models" in repoConfig));
});
