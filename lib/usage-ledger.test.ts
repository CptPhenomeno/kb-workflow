import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	aggregateByModel,
	aggregateByRole,
	appendRecord,
	readRecords,
	sumUsage,
	type UsageRecord,
} from "./usage-ledger.ts";

function assertCostClose(actual: number, expected: number): void {
	assert.ok(Math.abs(actual - expected) < 1e-9, `cost ${actual} should be ~${expected}`);
}

function tempLedger(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ledger-test-"));
	return path.join(dir, ".pi", "kb-usage.jsonl");
}

function sampleRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		runId: "run-1",
		at: "2026-11-14T10:00:00Z",
		agent: "agent-dev-KB-53",
		role: "developer",
		model: "claude-sonnet-4-5",
		thinkingLevel: "high",
		item: "KB-53",
		ok: true,
		usage: {
			input: 1000,
			output: 2000,
			cacheRead: 3000,
			cacheWrite: 4000,
			cost: 0.05,
			turns: 3,
		},
		...overrides,
	};
}

test("appendRecord writes one JSON line per round to <project>/.pi/kb-usage.jsonl", () => {
	const ledger = tempLedger();
	const record = sampleRecord();

	appendRecord(ledger, record);
	appendRecord(ledger, { ...sampleRecord(), item: "KB-54" });

	const lines = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean);
	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0]), record);
	assert.deepEqual(JSON.parse(lines[1]), { ...record, item: "KB-54" });
});

test("readRecords skips malformed lines and returns no records for a missing or unreadable ledger", () => {
	const ledger = tempLedger();
	const record = sampleRecord();

	// missing file
	assert.deepEqual(readRecords(ledger), []);

	// mixed valid and malformed lines
	fs.mkdirSync(path.dirname(ledger), { recursive: true });
	fs.writeFileSync(
		ledger,
		[
			"this is not json",
			JSON.stringify(record),
			JSON.stringify({ nonsense: true }),
			JSON.stringify({ ...sampleRecord(), runId: "run-2" }),
			"",
		].join("\n") + "\n",
	);

	assert.deepEqual(readRecords(ledger), [record, { ...record, runId: "run-2" }]);

	// unreadable file (a directory)
	const dirAsLedger = path.join(path.dirname(ledger), "not-a-file");
	fs.mkdirSync(dirAsLedger);
	assert.deepEqual(readRecords(dirAsLedger), []);
});

test("the ledger file is append-only: existing lines are never rewritten", () => {
	const ledger = tempLedger();
	const first = sampleRecord();

	appendRecord(ledger, first);
	const before = fs.readFileSync(ledger, "utf8");

	appendRecord(ledger, { ...sampleRecord(), agent: "agent-review-KB-53" });
	const after = fs.readFileSync(ledger, "utf8");

	assert.ok(after.startsWith(before), "existing content must stay byte-identical at the front");
	assert.equal(after.slice(before.length).trim(), JSON.stringify({ ...first, agent: "agent-review-KB-53" }));

	// a write failure never throws (NFR-15): the ledger path is a directory
	const dirAsLedger = path.join(path.dirname(ledger), "not-a-file");
	fs.mkdirSync(dirAsLedger);
	assert.doesNotThrow(() => appendRecord(dirAsLedger, first));
});

test("aggregation returns totals per role and per model with cacheRead and cacheWrite kept separate", () => {
	const records: UsageRecord[] = [
		sampleRecord(), // developer, claude-sonnet-4-5
		sampleRecord({ role: "planner", model: "claude-opus-4-1", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.01, turns: 1 } }),
		sampleRecord({ role: "developer", model: "claude-opus-4-1", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.001, turns: 1 } }),
	];

	const byRole = aggregateByRole(records);
	assert.equal(byRole.size, 2);
	const dev = byRole.get("developer")!;
	assert.equal(dev.input, 1001);
	assert.equal(dev.output, 2002);
	assert.equal(dev.cacheRead, 3003);
	assert.equal(dev.cacheWrite, 4004);
	assertCostClose(dev.cost, 0.051);
	assert.equal(dev.turns, 4);
	assert.equal(dev.rounds, 2);
	const planner = byRole.get("planner")!;
	assert.equal(planner.input, 10);
	assert.equal(planner.cacheRead, 30);

	const byModel = aggregateByModel(records);
	assert.equal(byModel.size, 2);
	const opus = byModel.get("claude-opus-4-1")!;
	assert.equal(opus.input, 11);
	assert.equal(opus.output, 22);
	assert.equal(opus.cacheRead, 33);
	assert.equal(opus.cacheWrite, 44);
	assert.equal(opus.rounds, 2);

	const totals = sumUsage(records);
	assert.equal(totals.input, 1011);
	assert.equal(totals.output, 2022);
	assert.equal(totals.cacheRead, 3033);
	assert.equal(totals.cacheWrite, 4044);
	assertCostClose(totals.cost, 0.061);
	assert.equal(totals.turns, 5);
	assert.equal(totals.rounds, 3);

	// empty ledger aggregates to zeros
	const zero = sumUsage([]);
	assert.equal(zero.input, 0);
	assert.equal(zero.output, 0);
	assert.equal(zero.cacheRead, 0);
	assert.equal(zero.cacheWrite, 0);
	assert.equal(zero.cost, 0);
	assert.equal(zero.turns, 0);
	assert.equal(zero.rounds, 0);
});

test("the module imports no pi package, only Node builtins", () => {
	const source = fs.readFileSync(new URL("./usage-ledger.ts", import.meta.url), "utf8");
	const imports = [
		...source.matchAll(/import\s+(?:[^;]+?\s+from\s+)?["']([^"']+)["']/g),
	].map((m) => m[1]);
	assert.ok(imports.length > 0, "the module should declare its imports");
	for (const specifier of imports) {
		assert.match(specifier, /^node:/, `import must be a Node builtin, got: ${specifier}`);
	}
});
