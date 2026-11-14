/**
 * The TUI-only entry channel (FR-30 / AC-39, amended 2026-11-14).
 *
 * Usage reports — the cumulative /kb-cost table and the FR-29 "Usage this
 * run" block — are delivered as custom entries (`pi.appendEntry`) on the
 * dedicated `kb-usage` type, rendered by the shared entry renderer
 * (lib/usage-entry-renderer.ts). Custom entries do NOT participate in LLM
 * context, so the reports never reach the model: nothing is billed, the
 * conversation stays clean, and the command needs no isIdle guard.
 *
 * Pure Node builtins, no pi imports (NFR-17): the payload helpers stay
 * unit-testable in isolation, and the renderer module owns everything
 * pi-facing.
 */

/** The dedicated custom-entry type of the TUI-only channel. */
export const USAGE_ENTRY_TYPE = "kb-usage";

/** The payload of a usage entry: markdown the shared renderer displays. */
export interface UsageEntryData {
	markdown: string;
}

/** Stands in for `pi.appendEntry(customType, data?)`. */
export type AppendEntry = (customType: string, data?: unknown) => void;

/**
 * Build the entry payload for a usage report. The markdown is rendered by
 * the shared entry renderer inside a customMessageBg-styled block.
 */
export function usageEntryData(markdown: string): UsageEntryData {
	return { markdown };
}

/**
 * Deliver a usage report through the TUI-only channel: one custom entry on
 * the dedicated type. Shared by /kb-cost (FR-30) and the message-mode
 * "Usage this run" block (FR-29).
 */
export function appendUsageEntry(appendEntry: AppendEntry, markdown: string): void {
	appendEntry(USAGE_ENTRY_TYPE, usageEntryData(markdown));
}
