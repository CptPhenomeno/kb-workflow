/**
 * Model and thinking-level configuration for the kb subagents.
 *
 * Shape (v0.2.0, `kb-agents`):
 *   {
 *     "kb-agents": {
 *       "planner":   { "model": "provider/model", "thinking-level": "high" },
 *       "developer": { "model": "provider/model", "thinking-level": "medium" },
 *       "reviewer":  { "model": "provider/model", "thinking-level": "low" },
 *       "qa":        { "model": "provider/model", "thinking-level": "low" }
 *     }
 *   }
 *
 * The old `models` format is no longer supported by the parser: a file
 * without a valid `kb-agents` object contributes nothing (FR-17).
 * Malformed files are skipped without crashing (NFR-12).
 *
 * A missing model falls back to the model active in the dispatching pi
 * session; a missing (or invalid) thinking level falls back to that
 * session's thinking level (FR-20).
 *
 * This module is pure (no filesystem / pi-package imports) so it stays
 * unit-testable; the loader lives in `./config-load.ts`.
 */

export type AgentRole = "planner" | "developer" | "reviewer" | "qa";

/** Thinking levels recognized by pi. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const AGENT_ROLES: readonly AgentRole[] = ["planner", "developer", "reviewer", "qa"];

/** Per-role config: each property is optional and resolved independently. */
export interface RoleConfig {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export type KbAgentsConfig = Partial<Record<AgentRole, RoleConfig>>;

export interface KbWorkflowConfig {
	/** The v0.2.0 `kb-agents` shape (the old `models` format is unsupported, FR-17). */
	kbAgents?: KbAgentsConfig;
}

/** Validate a raw thinking-level value; unknown values are treated as unset (FR-19). */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate the `kb-agents` object of a config file.
 * Anything that is not a well-formed `kb-agents` object (including the
 * old `models` format) yields an empty config — never a throw (FR-17, NFR-12).
 */
export function parseKbAgents(raw: unknown): KbAgentsConfig {
	const result: KbAgentsConfig = {};
	if (!isRecord(raw)) return result;
	const kbAgents = raw["kb-agents"];
	if (!isRecord(kbAgents)) return result;
	for (const role of AGENT_ROLES) {
		const entry = kbAgents[role];
		if (!isRecord(entry)) continue;
		const model = typeof entry["model"] === "string" ? entry["model"] : undefined;
		const thinkingLevel = parseThinkingLevel(entry["thinking-level"]);
		if (model === undefined && thinkingLevel === undefined) continue;
		result[role] = {};
		if (model !== undefined) result[role].model = model;
		if (thinkingLevel !== undefined) result[role].thinkingLevel = thinkingLevel;
	}
	return result;
}

/**
 * Deep per-property merge of two parsed configs (project wins per property, FR-18).
 * For each of the four roles, `model` and `thinkingLevel` are merged independently,
 * so a role may take its model from one file and its thinking level from the other,
 * in both directions.
 */
export function mergeKbAgents(global: KbAgentsConfig, project: KbAgentsConfig): KbAgentsConfig {
	const merged: KbAgentsConfig = {};
	for (const role of AGENT_ROLES) {
		const g = global[role];
		const p = project[role];
		if (!g && !p) continue;
		const roleConfig: RoleConfig = { ...g };
		if (p) {
			roleConfig.model = p.model ?? roleConfig.model;
			roleConfig.thinkingLevel = p.thinkingLevel ?? roleConfig.thinkingLevel;
		}
		if (roleConfig.model !== undefined || roleConfig.thinkingLevel !== undefined) {
			merged[role] = roleConfig;
		}
	}
	return merged;
}

/** Session values used as fallbacks when a role's config is unset. */
export interface SessionFallbacks {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Resolve both the model and the thinking level for a role in one place.
 * Each property falls back independently to the dispatching session's
 * value when unset (or invalid, since invalid levels are dropped at parse
 * time) in the config — always forwarded, including when the model is
 * explicitly configured (FR-20).
 */
export function resolveAgentConfig(
	role: AgentRole,
	config: KbWorkflowConfig,
	session?: SessionFallbacks,
): RoleConfig {
	const roleConfig = config.kbAgents?.[role] ?? {};
	return {
		model: roleConfig.model ?? session?.model,
		thinkingLevel: roleConfig.thinkingLevel ?? session?.thinkingLevel,
	};
}


