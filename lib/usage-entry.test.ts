/**
 * Tests for the TUI-only entry channel (FR-30 / AC-39, amended 2026-11-14):
 * /kb-cost delivers its table through `pi.appendEntry` plus a registered
 * entry renderer for a dedicated custom type — custom entries never enter
 * the LLM context — and the same channel/renderer is shared with the FR-29
 * message-mode "Usage this run" block.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Box, Markdown } from "@earendil-works/pi-tui";
import { appendRecord, type UsageRecord } from "./usage-ledger.ts";
import {
	renderCostReport,
	renderRunUsageBlock,
	runCostCommand,
} from "./cost-report.ts";
import {
	appendUsageEntry,
	USAGE_ENTRY_TYPE,
	usageEntryData,
	type UsageEntryData,
} from "./usage-entry.ts";
import { usageEntryRenderer } from "./usage-entry-renderer.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexTs = fs.readFileSync(path.join(root, "index.ts"), "utf8");
/** The /kb-cost command registration: the last block of index.ts. */
const kbCostBlock = indexTs.slice(indexTs.indexOf('pi.registerCommand("kb-cost"'));

function sampleRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		runId: "run-1",
		at: "2026-11-14T10:00:00Z",
		agent: "agent-dev-KB-60",
		role: "developer",
		model: "anthropic/claude-sonnet-4.5",
		thinkingLevel: "high",
		item: "KB-60",
		ok: true,
		usage: {
			input: 4000,
			output: 3000,
			cacheRead: 1000000,
			cacheWrite: 2000,
			cost: 1.25,
			turns: 2,
		},
		...overrides,
	};
}

function tempCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "kb-cost-test-"));
}

/** Captures appendEntry calls: (customType, data) pairs. */
function captureEntries(): {
	appended: { customType: string; data?: unknown }[];
	appendEntry: (customType: string, data?: unknown) => void;
} {
	const appended: { customType: string; data?: unknown }[] = [];
	return { appended, appendEntry: (customType, data) => void appended.push({ customType, data }) };
}

test("/kb-cost delivers its table through appendEntry instead of sendMessage", () => {
	const cwd = tempCwd();
	appendRecord(path.join(cwd, ".pi", "kb-usage.jsonl"), sampleRecord());
	const { appended, appendEntry } = captureEntries();

	runCostCommand({ cwd, appendEntry });

	// Exactly one custom entry on the dedicated type, never a custom message.
	assert.equal(appended.length, 1);
	assert.equal(appended[0].customType, USAGE_ENTRY_TYPE);
	const data = appended[0].data as UsageEntryData;
	assert.ok(data.markdown.startsWith("**kb-cost — cumulative across 1 runs**"), data.markdown);

	// index.ts wires the command through the appendEntry seam: the command
	// block must not send a custom message (which would enter LLM context).
	assert.ok(kbCostBlock.includes("appendEntry"), "the command delivers through appendEntry");
	assert.ok(!kbCostBlock.includes("sendMessage"), "the command must not call sendMessage");
});

test("the registered entry renderer renders the markdown table inside a customMessageBg block with a GFM table and a bold totals row", () => {
	// A fake pi theme records which theme tokens the renderer styles with.
	const bgNames: string[] = [];
	const fgNames: string[] = [];
	const theme = {
		bg: (name: string, text: string) => {
			bgNames.push(name);
			return text;
		},
		fg: (name: string, text: string) => {
			fgNames.push(name);
			return text;
		},
	};

	const entry = {
		type: "custom" as const,
		customType: USAGE_ENTRY_TYPE,
		data: usageEntryData(renderCostReport([sampleRecord()])),
	};
	const box = usageEntryRenderer(entry, { expanded: false }, theme);

	// The prototype look: a Box styled with the customMessageBg background
	// wrapping one real Markdown child (the GFM table with bold totals row).
	assert.ok(box instanceof Box);
	assert.equal(box.children.length, 1);
	const markdown = box.children[0];
	assert.ok(markdown instanceof Markdown);
	assert.ok(markdown.text.includes("| role | model | tokens in/out (cache r/w) | cost |"), markdown.text);
	assert.ok(markdown.text.includes("|---|---|---|---|"), markdown.text);
	assert.ok(markdown.text.includes("| **total** |"), markdown.text);
	// Rendered through the block: the background is applied per line.
	const lines = box.render(100);
	assert.ok(lines.join("\n").includes("kb-cost — cumulative across 1 runs"), lines.join("\n"));
	assert.ok(bgNames.includes("customMessageBg"), `styled with customMessageBg, got ${bgNames}`);
	assert.ok(fgNames.includes("customMessageText"), `markdown text uses customMessageText, got ${fgNames}`);
});

test("the /kb-cost entry never enters the LLM context and the command has no isIdle guard", () => {
	// Custom entries do not participate in LLM context by pi semantics; the
	// command therefore needs no isIdle guard — it is usable while busy.
	assert.ok(!kbCostBlock.includes("ctx.isIdle("), "the command must not guard on isIdle");
	assert.ok(kbCostBlock.includes("appendEntry"), "delivery is appendEntry (TUI-only)");

	// Contrast: the context-touching commands keep their guard — only
	// /kb-cost lost it (its output no longer reaches the model).
	const kbPlanBlock = indexTs.slice(
		indexTs.indexOf('pi.registerCommand("kb-plan"'),
		indexTs.indexOf('pi.registerCommand("kb-dev"'),
	);
	assert.ok(kbPlanBlock.includes("ctx.isIdle("), "kb-plan still guards on isIdle");
});

test("the entry renderer is shared so the message-mode usage block can reuse it", () => {
	// Any markdown goes through the same channel — the FR-29 "Usage this
	// run" block will call the same helpers, not a copy of the command.
	const { appended, appendEntry } = captureEntries();
	appendUsageEntry(appendEntry, renderRunUsageBlock([]));
	assert.equal(appended.length, 1);
	assert.equal(appended[0].customType, USAGE_ENTRY_TYPE);
	assert.ok((appended[0].data as UsageEntryData).markdown.includes("**Usage this run**"));

	// index.ts registers the renderer once in the factory from the shared
	// lib module; the command does not inline its own renderer.
	assert.ok(indexTs.includes("registerUsageEntryRenderer(pi)"), "the factory registers the shared renderer");
	assert.ok(indexTs.includes('from "./lib/usage-entry-renderer.ts"'), "the renderer lives in lib/");
	assert.ok(!kbCostBlock.includes("registerEntryRenderer"), "the command does not inline a renderer");
});

test("/kb-cost on an empty or missing ledger still renders zeros through the entry channel", () => {
	// Missing ledger: no .pi directory at all.
	const cwd = tempCwd();
	const { appended, appendEntry } = captureEntries();
	assert.doesNotThrow(() => runCostCommand({ cwd, appendEntry }));
	assert.equal(appended.length, 1);
	assert.equal(appended[0].customType, USAGE_ENTRY_TYPE);
	const data = appended[0].data as UsageEntryData;
	assert.ok(data.markdown.includes("**kb-cost — cumulative across 0 runs**"), data.markdown);
	assert.ok(data.markdown.includes("| **total** | | **0/0 (0/0)** | **€0.00** |"), data.markdown);
});
