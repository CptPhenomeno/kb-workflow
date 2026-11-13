/**
 * Model configuration for the kb subagents.
 *
 * Resolution order (later wins, shallow merge on `models`):
 *   1. <agentDir>/kb-workflow.json        (global, e.g. ~/.pi/agent/kb-workflow.json)
 *   2. <project>/.pi/kb-workflow.json     (project-local override, CONFIG_DIR_NAME aware)
 *
 * Shape:
 *   { "models": { "planner": "provider/model", "developer": "...", "reviewer": "...", "qa": "..." } }
 *
 * A missing role falls back to the model active in the dispatching pi session.
 *
 * This module is pure (no filesystem / pi-package imports) so it stays
 * unit-testable; the loader lives in `./config-load.ts`.
 */

export type AgentRole = "planner" | "developer" | "reviewer" | "qa";

export interface KbWorkflowConfig {
	models?: Partial<Record<AgentRole, string>>;
}

/** Resolve the model for a role; falls back to the caller's active model when unset. */
export function resolveAgentModel(role: AgentRole, config: KbWorkflowConfig, fallback?: string): string | undefined {
	return config.models?.[role] ?? fallback;
}
