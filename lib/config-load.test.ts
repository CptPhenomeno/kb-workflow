import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKbWorkflowConfig } from "./config-load.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "kb-workflow-config-"));
}

function writeConfig(dir: string, body: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "kb-workflow.json"), JSON.stringify(body));
}

test("loader reads the config from the extension folder (module-relative)", () => {
	// default: resolved module-relative, i.e. the extension root shipping kb-workflow.json.
	// The shipped file may still be in the old `models` format until KB-10 rewrites it
	// (FR-17: it then contributes nothing); either way loading must not throw.
	const config = loadKbWorkflowConfig(tempDir());
	assert.equal(typeof config, "object");

	// injected extension folder: its config takes effect
	const ext = tempDir();
	writeConfig(ext, { "kb-agents": { planner: { model: "provider/ext-model" } } });
	const config2 = loadKbWorkflowConfig(tempDir(), { extensionFolder: ext });
	assert.equal(config2.kbAgents?.planner?.model, "provider/ext-model");
});

test("agents-folder config is ignored", () => {
	const agents = tempDir();
	writeConfig(agents, { "kb-agents": { planner: { model: "provider/agents-model" } } });
	process.env.PI_CODING_AGENT_DIR = agents;
	try {
		const ext = tempDir(); // no config there at all
		const config = loadKbWorkflowConfig(tempDir(), { extensionFolder: ext });
		assert.equal(config.kbAgents?.planner, undefined); // agents folder is never read
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

test("role takes model from the extension-folder config and thinking-level from the project config", () => {
	const ext = tempDir();
	writeConfig(ext, { "kb-agents": { developer: { model: "provider/ext-developer" } } });
	const project = tempDir();
	writeConfig(path.join(project, ".pi"), { "kb-agents": { developer: { "thinking-level": "high" } } });
	const config = loadKbWorkflowConfig(project, { extensionFolder: ext });
	assert.equal(config.kbAgents?.developer?.model, "provider/ext-developer");
	assert.equal(config.kbAgents?.developer?.thinkingLevel, "high");
});

test("role takes model from the project config and thinking-level from the extension-folder config", () => {
	const ext = tempDir();
	writeConfig(ext, { "kb-agents": { qa: { "thinking-level": "low" } } });
	const project = tempDir();
	writeConfig(path.join(project, ".pi"), { "kb-agents": { qa: { model: "provider/project-qa" } } });
	const config = loadKbWorkflowConfig(project, { extensionFolder: ext });
	assert.equal(config.kbAgents?.qa?.model, "provider/project-qa");
	assert.equal(config.kbAgents?.qa?.thinkingLevel, "low");
});

test("project property overrides the same property from the extension-folder config", () => {
	const ext = tempDir();
	writeConfig(ext, {
		"kb-agents": {
			planner: { model: "provider/ext-planner", "thinking-level": "low" },
			reviewer: { model: "provider/ext-reviewer", "thinking-level": "medium" },
		},
	});
	const project = tempDir();
	writeConfig(path.join(project, ".pi"), {
		"kb-agents": {
			planner: { model: "provider/project-planner" },
			reviewer: { "thinking-level": "high" },
		},
	});
	const config = loadKbWorkflowConfig(project, { extensionFolder: ext });
	assert.equal(config.kbAgents?.planner?.model, "provider/project-planner"); // project wins
	assert.equal(config.kbAgents?.planner?.thinkingLevel, "low"); // untouched property survives
	assert.equal(config.kbAgents?.reviewer?.model, "provider/ext-reviewer");
	assert.equal(config.kbAgents?.reviewer?.thinkingLevel, "high");
});

test("an old models-format file contributes nothing to the merge", () => {
	const ext = tempDir();
	writeConfig(ext, { models: { planner: "provider/old-ext" } });
	const project = tempDir();
	writeConfig(path.join(project, ".pi"), { models: { developer: "provider/old-project" } });
	const config = loadKbWorkflowConfig(project, { extensionFolder: ext });
	assert.deepEqual(config.kbAgents, {});
});

test("malformed config files are skipped, never fatal", () => {
	const ext = tempDir();
	fs.mkdirSync(ext, { recursive: true });
	fs.writeFileSync(path.join(ext, "kb-workflow.json"), "{ not json");
	const project = tempDir();
	writeConfig(path.join(project, ".pi"), { "kb-agents": { qa: { model: "provider/qa" } } });
	const config = loadKbWorkflowConfig(project, { extensionFolder: ext });
	assert.equal(config.kbAgents?.qa?.model, "provider/qa");
});
