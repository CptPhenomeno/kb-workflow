/**
 * Orchestration seams for the /kb-dev handler (SPEC v0.1.0).
 *
 * Extracted from the command handler so the per-task flow is unit-testable
 * without spawning real subagents: the handler's deterministic steps
 * (FR-2 branch creation/checkout) run around an injected `spawnDev`.
 */

import { ensureTaskBranch } from "./git.ts";
import type { KbItem } from "./kb.ts";

export interface DevRoundResult<T> {
	/** The task branch that was active when the developer was spawned. */
	branch: string;
	/** Whatever the injected spawn function returned. */
	result: T;
}

export interface DevRoundOptions<T> {
	cwd: string;
	task: KbItem;
	/**
	 * Stands in for `runSubagent(kb-developer)`. It is called only after the
	 * task branch (`feature/<id>` / `fix/<id>`, FR-2) has been created from
	 * or reused from `develop` and checked out, so the developer finds it
	 * active.
	 */
	spawnDev: () => Promise<T>;
}

/**
 * One developer round for a task (FR-2, AC-2, AC-6): ensure the task branch
 * exists (created from develop, or reused as-is from an earlier round) and
 * is checked out, then run the developer.
 */
export async function runDeveloperRound<T>(opts: DevRoundOptions<T>): Promise<DevRoundResult<T>> {
	const branch = await ensureTaskBranch(opts.cwd, opts.task.type, opts.task.id);
	const result = await opts.spawnDev();
	return { branch, result };
}
