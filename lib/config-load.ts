/**
 * Loader for the kb-workflow.json model configuration (see ./config.ts for the
 * shape and resolution rules). Kept apart from the pure config module because
 * it reads the filesystem and imports the pi package.
 *
 * FR-15: the global config is read from the extension's own folder (resolved
 * module-relative, so it works identically from source and installed), plus
 * the project-local .pi/kb-workflow.json override. The agents-folder lookup
 * is gone — there is no fallback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { KbWorkflowConfig } from "./config.ts";

function readJson(file: string): KbWorkflowConfig | undefined {
	try {
		if (!fs.existsSync(file)) return undefined;
		return JSON.parse(fs.readFileSync(file, "utf8")) as KbWorkflowConfig;
	} catch {
		return undefined; // malformed config files are ignored, never fatal
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
	const global = readJson(path.join(folder, "kb-workflow.json"));
	const project = readJson(path.join(cwd, CONFIG_DIR_NAME, "kb-workflow.json"));
	return { models: { ...global?.models, ...project?.models } };
}
