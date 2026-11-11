/**
 * Model configuration for the kb subagents.
 *
 * Resolution order (later wins, shallow merge on `models`):
 *   1. <agentDir>/kb-workflow.json        (global, e.g. ~/.pi/agent/kb-workflow.json)
 *   2. <project>/.pi/kb-workflow.json     (project-local override, CONFIG_DIR_NAME aware)
 *
 * Shape:
 *   { "models": { "planner": "provider/model", "developer": "...", "reviewer": "..." } }
 *
 * A missing role falls back to the model active in the dispatching pi session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type AgentRole = "planner" | "developer" | "reviewer";

export interface KbWorkflowConfig {
	models?: Partial<Record<AgentRole, string>>;
}

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

/** Resolve the model for a role; falls back to the caller's active model when unset. */
export function resolveAgentModel(role: AgentRole, config: KbWorkflowConfig, fallback?: string): string | undefined {
	return config.models?.[role] ?? fallback;
}
