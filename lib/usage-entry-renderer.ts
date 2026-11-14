/**
 * The shared entry renderer for the TUI-only usage channel
 * (FR-30 / AC-39, amended 2026-11-14).
 *
 * Renders `kb-usage` custom entries (lib/usage-entry.ts) the way the
 * validated prototype does (prototype/kb-tui-prototype.mjs, the
 * costBlock/reportBlock look): the real Markdown component inside a
 * `customMessageBg`-styled Box, the markdown text colored
 * `customMessageText`. Registered once in the extension factory; /kb-cost
 * (FR-30) and the message-mode "Usage this run" block (FR-29) both deliver
 * through appendEntry on the same type, so both get this look.
 *
 * Custom entries do NOT participate in LLM context: the rendered reports
 * never reach the model.
 */

import { getMarkdownTheme, type EntryRenderer, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";

import { USAGE_ENTRY_TYPE, type UsageEntryData } from "./usage-entry.ts";

/**
 * The entry renderer: a customMessageBg Box wrapping the real Markdown
 * component with the entry's markdown (GFM tables included).
 */
export const usageEntryRenderer: EntryRenderer<UsageEntryData> = (entry, _options, theme: Theme) => {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(
		new Markdown(entry.data?.markdown ?? "", 0, 0, getMarkdownTheme(), {
			color: (text) => theme.fg("customMessageText", text),
		}),
	);
	return box;
};

/**
 * Register the shared renderer on the extension's pi API. Called once in
 * the factory so every `kb-usage` entry — from /kb-cost or the FR-29
 * message-mode usage block — renders through it.
 */
export function registerUsageEntryRenderer(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
	pi.registerEntryRenderer(USAGE_ENTRY_TYPE, usageEntryRenderer);
}
