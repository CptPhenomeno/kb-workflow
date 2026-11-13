/**
 * Loader for the kb-workflow.json model configuration (see ./config.ts for the
 * shape and resolution rules). Kept apart from the pure config module because
 * it reads the filesystem and imports the pi package.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KbWorkflowConfig } from "./config.ts";

function readJson(file: string): KbWorkflowConfig | undefined {
	try {
		if (!fs.existsSync(file)) return undefined;
		return JSON.parse(fs.readFileSync(file, "utf8")) as KbWorkflowConfig;
	} catch {
		return undefined; // malformed config files are ignored, never fatal
	}
}

export function loadKbWorkflowConfig(cwd: string): KbWorkflowConfig {
	const global = readJson(path.join(getAgentDir(), "kb-workflow.json"));
	const project = readJson(path.join(cwd, CONFIG_DIR_NAME, "kb-workflow.json"));
	return { models: { ...global?.models, ...project?.models } };
}
