/**
 * Argument parsing and mode dispatch for the /kb-dev command (FR-9 / FR-10).
 *
 * The handler stays deterministic: `parseDevArgs` decides the retrieval mode
 * from the raw command arguments, and `dispatchDev` hands the run to exactly
 * one mode runner. The bare runner resolves its single element via `kb next`
 * (NFR-7); the message runner builds the fixed kickoff template (FR-10).
 */

export type DevMode = { mode: "bare"; message: null } | { mode: "message"; message: string };

/** Parse the raw `/kb-dev` arguments into the retrieval mode. */
export function parseDevArgs(args: string): DevMode {
	const message = args.trim();
	if (!message) return { mode: "bare", message: null };
	return { mode: "message", message };
}

export interface DispatchDeps {
	/** Raw command arguments as received by the handler. */
	args: string;
	/** Bare mode: work the next board-level element via `kb next`. */
	runBare: () => Promise<{ report: string }>;
	/** Message mode: deliver the kickoff with the user message. */
	runMessage: (message: string) => Promise<{ report: string; delivered: boolean }>;
}

/**
 * Dispatch one /kb-dev invocation to the mode selected by the arguments.
 * Exactly one runner is invoked, exactly once.
 */
export async function dispatchDev(deps: DispatchDeps): Promise<{ report: string; delivered?: boolean }> {
	const parsed = parseDevArgs(deps.args);
	if (parsed.mode === "message") {
		const result = await deps.runMessage(parsed.message);
		return { report: result.report, delivered: result.delivered };
	}
	const result = await deps.runBare();
	return { report: result.report };
}
