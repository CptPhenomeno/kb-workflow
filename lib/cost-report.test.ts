import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { appendRecord, type UsageRecord } from "./usage-ledger.ts";
import { renderCostReport, runCostCommand, type SentCustomMessage } from "./cost-report.ts";

function sampleRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		runId: "run-1",
		at: "2026-11-14T10:00:00Z",
		agent: "agent-dev-KB-53",
		role: "developer",
		model: "anthropic/claude-sonnet-4.5",
		thinkingLevel: "high",
		item: "KB-53",
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

/** Two runs: a developer round each, plus a reviewer round in the second. */
function twoRunRecords(): UsageRecord[] {
	return [
		sampleRecord(),
		sampleRecord({
			runId: "run-2",
			at: "2026-11-14T11:00:00Z",
			agent: "agent-dev-KB-55",
			item: "KB-55",
			usage: { input: 12000, output: 5000, cacheRead: 900000, cacheWrite: 1000, cost: 0.75, turns: 1 },
		}),
		sampleRecord({
			runId: "run-2",
			agent: "agent-review-KB-55",
			role: "reviewer",
			model: "openai/gpt-5.1-mini",
			item: "KB-55",
			usage: { input: 2000, output: 1000, cacheRead: 500000, cacheWrite: 0, cost: 0.1, turns: 1 },
		}),
	];
}

function tempCwd(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "kb-cost-test-"));
}

function captureMessages(): { sent: SentCustomMessage[]; send: (m: SentCustomMessage) => void } {
	const sent: SentCustomMessage[] = [];
	return { sent, send: (m) => void sent.push(m) };
}

test("cumulative totals are readable with one command across runs", () => {
	const md = renderCostReport(twoRunRecords());

	// Both runs are counted, and their figures are summed per role.
	assert.ok(md.includes("**kb-cost — cumulative across 2 runs**"), md);
	assert.ok(md.includes("| developer | anthropic/claude-sonnet-4.5 | 16k/8k (1.9M/3k) | €2.00 |"), md);
	assert.ok(md.includes("| reviewer | openai/gpt-5.1-mini | 2k/1k (500k/0) | €0.10 |"), md);
	// Overall tokens and euros across runs.
	assert.ok(md.includes("| **total** | | **18k/9k (2.4M/3k)** | **€2.10** |"), md);

	// One command on a real ledger directory reads and aggregates both runs.
	const cwd = tempCwd();
	const ledger = path.join(cwd, ".pi", "kb-usage.jsonl");
	for (const record of twoRunRecords()) {
		appendRecord(ledger, record);
	}
	const { sent, send } = captureMessages();
	runCostCommand({ cwd, sendMessage: send });
	assert.equal(sent.length, 1);
	assert.ok(sent[0].content.includes("**€2.10**"), sent[0].content);
});

test("/kb-cost renders a GFM table with one row per role and a bold totals row", () => {
	const md = renderCostReport(twoRunRecords());
	const lines = md.split("\n");

	// GFM table: header row and separator.
	assert.equal(lines[2], "| role | model | tokens in/out (cache r/w) | cost |");
	assert.equal(lines[3], "|---|---|---|---|");
	// One data row per role, then the bold totals row.
	assert.equal(lines[4], "| developer | anthropic/claude-sonnet-4.5 | 16k/8k (1.9M/3k) | €2.00 |");
	assert.equal(lines[5], "| reviewer | openai/gpt-5.1-mini | 2k/1k (500k/0) | €0.10 |");
	assert.equal(lines[6], "| **total** | | **18k/9k (2.4M/3k)** | **€2.10** |");
	assert.equal(lines.length, 7);

	// Per-model breakdown: a role that ran two models gets one row per model.
	const twoModels = [
		sampleRecord(),
		sampleRecord({ model: "openai/gpt-5.1-mini", usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 1 } }),
	];
	const md2 = renderCostReport(twoModels);
	assert.ok(md2.includes("| developer | anthropic/claude-sonnet-4.5 |"), md2);
	assert.ok(md2.includes("| developer | openai/gpt-5.1-mini |"), md2);
});

test("/kb-cost on an empty or missing ledger renders zeros instead of failing", () => {
	// Missing ledger: no .pi directory at all.
	const cwd = tempCwd();
	const { sent, send } = captureMessages();
	assert.doesNotThrow(() => runCostCommand({ cwd, sendMessage: send }));
	assert.equal(sent.length, 1);
	assert.ok(sent[0].content.includes("**kb-cost — cumulative across 0 runs**"), sent[0].content);
	assert.ok(sent[0].content.includes("| **total** | | **0/0 (0/0)** | **€0.00** |"), sent[0].content);

	// Empty record list renders the same zeroed table.
	const md = renderCostReport([]);
	assert.ok(md.includes("**kb-cost — cumulative across 0 runs**"), md);
	assert.ok(md.includes("| **total** | | **0/0 (0/0)** | **€0.00** |"), md);
});

test("the command output is markdown rendered inside a custom-message block", () => {
	const cwd = tempCwd();
	appendRecord(path.join(cwd, ".pi", "kb-usage.jsonl"), sampleRecord());
	const { sent, send } = captureMessages();
	runCostCommand({ cwd, sendMessage: send });

	assert.equal(sent.length, 1);
	const message = sent[0];
	// The custom-message block the TUI renders with the Markdown component.
	assert.equal(message.customType, "kb-workflow");
	assert.equal(message.display, true);
	// The content is markdown: bold header and a GFM table.
	assert.ok(message.content.startsWith("**kb-cost — cumulative across 1 runs**"), message.content);
	assert.ok(message.content.includes("| role | model | tokens in/out (cache r/w) | cost |"), message.content);
	assert.ok(message.content.includes("|---|---|---|---|"), message.content);
});
