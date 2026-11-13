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

function writeConfig(dir: string, models: Record<string, string>): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "kb-workflow.json"), JSON.stringify({ models }));
}

test("loader reads the config from the extension folder (module-relative)", () => {
	// default: resolved module-relative, i.e. the extension root shipping kb-workflow.json
	const shipped = JSON.parse(
		fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "kb-workflow.json"), "utf8"),
	) as { models: Record<string, string> };
	const config = loadKbWorkflowConfig(tempDir());
	assert.equal(config.models?.planner, shipped.models.planner);

	// injected extension folder: its config takes effect
	const ext = tempDir();
	writeConfig(ext, { planner: "provider/ext-model" });
	assert.equal(loadKbWorkflowConfig(tempDir(), { extensionFolder: ext }).models?.planner, "provider/ext-model");
});

test("agents-folder config is ignored", () => {
	const agents = tempDir();
	writeConfig(agents, { planner: "provider/agents-model" });
	process.env.PI_CODING_AGENT_DIR = agents;
	try {
		const ext = tempDir(); // no config there at all
		const config = loadKbWorkflowConfig(tempDir(), { extensionFolder: ext });
		assert.equal(config.models?.planner, undefined); // agents folder is never read
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

test("project-local .pi override still wins per property", () => {
	const ext = tempDir();
	writeConfig(ext, { planner: "provider/ext-planner", developer: "provider/ext-developer" });
	const project = tempDir();
	writeConfig(path.join(project, ".pi"), { planner: "provider/project-planner" });
	const config = loadKbWorkflowConfig(project, { extensionFolder: ext });
	assert.equal(config.models?.planner, "provider/project-planner"); // project wins
	assert.equal(config.models?.developer, "provider/ext-developer"); // per-property fallback
});
