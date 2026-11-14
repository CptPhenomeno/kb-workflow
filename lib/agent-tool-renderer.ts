/**
 * Custom rendering for the `kb_agent` tool (FR-24 / AC-31, KB-49).
 *
 * Reproduces variant A of the validated prototype
 * (prototype/kb-tui-prototype.mjs, ←/→ switches variants, A won):
 *
 * - the title line is `kb_agent kb-developer [model · thinking high]` —
 *   the agent name in `toolTitle`, the model in `toolOutput`, the thinking
 *   badge in the theme's per-level token (thinkingOff / thinkingMinimal /
 *   thinkingLow / thinkingMedium / thinkingHigh / thinkingXhigh /
 *   thinkingMax, muted fallback);
 * - while running, the last streamed line is shown (`… <line>`);
 * - when finished, a `✓ completed` line plus the variant A usage line
 *   (duration, tokens in/out, cache r/w, cost, turns), then the streamed
 *   lines — every one when expanded, the last two when collapsed, with a
 *   `… (N more lines, <key> to expand)` hint.
 *
 * The tool-call shell and framing are pi's own: ToolExecutionComponent wraps
 * custom renderers in a state-tinted Box (toolPendingBg / toolSuccessBg), so
 * these renderers return bare `Text` components with zero padding and draw
 * no box, border, padding or spacer themselves.
 *
 * The resolved model and thinking level reach the title line through the
 * row-local render state: the partial renderResult stashes the config the
 * FR-23 updates carry and invalidates the row, so the call slot re-renders
 * with it. The final result's `details` (FR-24) carry the same config and
 * the streamed lines, so the rendering also works after a reload, when no
 * partial was replayed.
 */

import { Text } from "@earendil-works/pi-tui";

/** The theme tokens of the per-level thinking badge (the prototype's map). */
const THINKING_TOKENS: Record<string, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** The structural slice of pi's `Theme` the renderers style with. */
export interface RendererTheme {
	fg: (token: string, text: string) => string;
	bg: (token: string, text: string) => string;
	bold: (text: string) => string;
}

/** Shared row-local state across the call and result slots. */
export interface KbAgentRenderState {
	/** The resolved model of the running round, stashed from the updates. */
	model?: string;
	/** The resolved thinking level of the running round. */
	thinkingLevel?: string;
}

/** The structural slice of pi's `ToolRenderContext` the renderers read. */
export interface RendererContext {
	state: KbAgentRenderState;
	invalidate: () => void;
	durationMs?: number;
	keyHint: (keybinding: string, description: string) => string;
}

/** The `details` of a partial kb_agent result (FR-23, `KbAgentUpdate`). */
interface RunningDetails {
	agent?: string;
	running?: boolean;
	model?: string;
	thinkingLevel?: string;
}

/** The `details` of the final kb_agent result (FR-31, extended by FR-24). */
interface FinalDetails {
	ok?: boolean;
	agent?: string;
	exitCode?: number | null;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
	model?: string;
	thinkingLevel?: string;
	lines?: string[];
}

type ToolResultLike = {
	content: Array<{ type: string; text: string }>;
	details: unknown;
};

/** `thinking <level>`, styled with the theme's per-level token (muted fallback). */
export function thinkingBadge(theme: RendererTheme, level: string): string {
	return theme.fg(THINKING_TOKENS[level] ?? "muted", `thinking ${level}`);
}

/** The prototype's token formatter: 1.2M / 45k / 7. */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return `${n}`;
}

/** The prototype's euro formatter. */
export function formatEuro(n: number): string {
	return `€${n.toFixed(2)}`;
}

/** The prototype's duration formatter: milliseconds → `42.3s`. */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The variant A usage line (muted): duration, tokens in/out, cache r/w,
 * cost and turns of the round. The duration comes from the render context
 * (`durationMs`, undefined while running or for old results) and is simply
 * omitted then; a missing usage renders nothing.
 */
export function usageLine(
	theme: RendererTheme,
	usage: FinalDetails["usage"],
	durationMs: number | undefined,
): string {
	if (!usage) return durationMs === undefined ? "" : theme.fg("muted", `⏱ ${formatDuration(durationMs)}`);
	const segments: string[] = [];
	if (durationMs !== undefined) segments.push(`⏱ ${formatDuration(durationMs)}`);
	segments.push(`${formatTokens(usage.input)} in / ${formatTokens(usage.output)} out`);
	segments.push(`cache ${formatTokens(usage.cacheRead)}r/${formatTokens(usage.cacheWrite)}w`);
	segments.push(formatEuro(usage.cost));
	segments.push(`${usage.turns} turns`);
	return theme.fg("muted", segments.join(" · "));
}

/** The last non-empty line of the streamed text (the running line first). */
function lastStreamedLine(content: ToolResultLike["content"]): string {
	const text = content.find((part) => part.type === "text")?.text ?? "";
	return text.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "starting";
}

/**
 * Stash the resolved config into the shared row state and invalidate the
 * row when it changes — the mechanism that puts the config on the call
 * slot's title line while the subagent runs, and after a reload (the final
 * details carry the same config).
 */
function stashResolvedConfig(details: RunningDetails, context: RendererContext): void {
	const { model, thinkingLevel } = details;
	if (model === undefined && thinkingLevel === undefined) return;
	const state = context.state ?? (context.state = {});
	if (state.model === model && state.thinkingLevel === thinkingLevel) return;
	state.model = model;
	state.thinkingLevel = thinkingLevel;
	context.invalidate();
}

/**
 * The call slot (FR-24): the title line `kb_agent <agent>` in toolTitle,
 * with the resolved model and thinking level inline in brackets (variant
 * A) once the updates have stashed them — the model in toolOutput, the
 * thinking badge in the theme's per-level token, the brackets and dot
 * muted. Before the first update the bare title is shown.
 */
export function kbAgentRenderCall(args: { agent: string; task?: string }, theme: RendererTheme, context: RendererContext): Text {
	const title = theme.fg("toolTitle", theme.bold(`kb_agent ${args.agent}`));
	const parts: string[] = [];
	const { model, thinkingLevel } = context.state ?? {};
	if (model !== undefined) parts.push(theme.fg("toolOutput", model));
	if (thinkingLevel !== undefined) parts.push(thinkingBadge(theme, thinkingLevel));
	let text = title;
	if (parts.length > 0) {
		text += ` ${theme.fg("muted", "[")}${parts.join(` ${theme.fg("muted", "·")} `)}${theme.fg("muted", "]")}`;
	}
	return new Text(text, 0, 0);
}

/**
 * The result slot (FR-24). While running (isPartial): the last streamed
 * line, `… <line>`, after stashing the resolved config for the title line.
 * When finished: `✓ completed` (or `✗ failed`) plus the variant A usage
 * line, then the streamed lines — all of them expanded, the last two
 * collapsed with a `… (N more lines, <key> to expand)` hint.
 *
 * Returns a bare `Text(…, 0, 0)`: the state-tinted Box around it is pi's
 * own ToolExecutionComponent.
 */
export function kbAgentRenderResult(
	result: ToolResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: RendererTheme,
	context: RendererContext,
): Text {
	const details = (result.details ?? {}) as RunningDetails & FinalDetails;
	stashResolvedConfig(details, context);

	if (options.isPartial) {
		return new Text(`${theme.fg("muted", "…")} ${theme.fg("toolOutput", lastStreamedLine(result.content))}`, 0, 0);
	}

	const head =
		details.ok === false
			? theme.fg("error", `✗ failed (exit ${details.exitCode ?? "?"})`)
			: theme.fg("success", "✓ completed");
	const usage = usageLine(theme, details.usage, context.durationMs);
	let text = usage ? `${head} ${usage}` : head;

	const lines = details.lines ?? [];
	const visible = options.expanded ? lines : lines.slice(-2);
	for (const line of visible) {
		text += `\n${theme.fg("toolOutput", line)}`;
	}
	if (!options.expanded && lines.length > 2) {
		const hint = context.keyHint("app.tools.expand", "to expand");
		text += `\n  ${theme.fg("muted", `… (${lines.length - 2} more lines, ${hint})`)}`;
	}
	return new Text(text, 0, 0);
}
