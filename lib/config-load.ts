/**
 * Loader for the kb-workflow.json model configuration (see ./config.ts for the
 * shape and resolution rules). Kept apart from the pure config module because
 * it reads the filesystem and imports the pi package.
 *
 * FR-15: the global config is read from the extension's own folder (resolved
 * module-relative, so it works identically from source and installed), plus
 * the project-local .pi/kb-workflow.json override. The agents-folder lookup
 * is gone — there is no fallback.
 *
 * FR-18: the two files merge deeply, per single property: for each role,
 * `model` and `thinking-level` are merged independently (project wins per
 * property), so a role may take its model from one file and its thinking
 * level from the other. Both files are parsed with `parseKbAgents`, so a
 * file in the old `models` format contributes nothing (FR-17) and malformed
 * files are skipped, never fatal (NFR-12).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mergeKbAgents, parseKbAgents, type KbAgentsConfig, type KbWorkflowConfig } from "./config.ts";

function readKbAgents(file: string): KbAgentsConfig {
	try {
		if (!fs.existsSync(file)) return {};
		return parseKbAgents(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return {}; // malformed config files are ignored, never fatal (NFR-12)
	}
}

/**
 * The extension's own folder (the one shipping kb-workflow.json), derived
 * from the module location: this file lives in lib/, one level below the
 * extension root. Never hard-coded, so source and installed layouts behave
 * identically (NFR-11).
 */
export function extensionFolder(moduleUrl: string = import.meta.url): string {
	return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

export interface LoadKbWorkflowConfigOptions {
	/** Overrides the module-relative extension folder (for tests). */
	extensionFolder?: string;
}

export function loadKbWorkflowConfig(
	cwd: string,
	options: LoadKbWorkflowConfigOptions = {},
): KbWorkflowConfig {
	const folder = options.extensionFolder ?? extensionFolder();
	const global = readKbAgents(path.join(folder, "kb-workflow.json"));
	const project = readKbAgents(path.join(cwd, CONFIG_DIR_NAME, "kb-workflow.json"));
	// FR-18: deep per-property merge — for each role, model and thinking-level
	// merge independently (project wins per property). A file in the old `models`
	// format has no valid `kb-agents` object and contributes nothing (FR-17).
	return { kbAgents: mergeKbAgents(global, project) } as KbWorkflowConfig;
}
