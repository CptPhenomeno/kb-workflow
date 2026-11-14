/**
 * KB-61 / FR-29 (amended 2026-11-14) / AC-38 — the message-mode kickoff
 * window.
 *
 * In message mode the main agent spawns the dev rounds itself, so the
 * /kb-dev run's records cannot be aggregated per-call. The kickoff window
 * closes that gap: when the kickoff is delivered the /kb-dev runId becomes
 * the active kickoff in extension memory; every kb_agent call inside the
 * window records with that runId (FR-27 inheritance); when the agent
 * settles, the "Usage this run" block for the window's records — sweep plus
 * kickoff rounds alike — is emitted through the TUI-only channel (FR-30)
 * and the window closes. A window that recorded no rounds emits no block.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { executeKbAgent } from "./agent-tool.ts";
import type { KbAgentName, SubagentResult } from "./subagent.ts";
import {
	activeKickoffRunId,
	closeKickoffWindow,
	openKickoffWindow,
	settleKickoffWindow,
} from "./kickoff-window.ts";
import { USAGE_ENTRY_TYPE, type UsageEntryData } from "./usage-entry.ts";
import { appendRecord, readRecords, type UsageRecord } from "./usage-ledger.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "kb-kickoff-test-"));
}

function roundResult(agent: KbAgentName): SubagentResult {
	return {
		ok: true,
		agent,
		actor: "agent-test",
		output: `ran ${agent}`,
		stderr: "",
		exitCode: 0,
		usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, cost: 0.25, turns: 1 },
	};
}

function record(runId: string, agent: KbAgentName, cost: number): UsageRecord {
	return {
		runId,
		at: "2026-11-14T18:00:00Z",
		agent,
		role: agent.replace("kb-", "") as UsageRecord["role"],
		model: "provider/model",
		thinkingLevel: "high",
		item: "KB-42",
		ok: true,
		usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0, cost, turns: 1 },
	};
}

/** Capturing appendEntry seam: (customType, data) pairs. */
function captureAppend(): { appended: Array<{ type: string; data: unknown }>; appendEntry: (type: string, data?: unknown) => void } {
	const appended: Array<{ type: string; data: unknown }> = [];
	return {
		appended,
		appendEntry: (type, data) => appended.push({ type, data }),
	};
}

test("a kb_agent call made while a kickoff window is open is recorded with the kickoff runId", async (t) => {
	const dir = tmpDir();
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		closeKickoffWindow();
	});
	const ledgerPath = path.join(dir, ".pi", "kb-usage.jsonl");

	// The kickoff window is open with the /kb-dev run's id (FR-29).
	openKickoffWindow("kb-dev-kickoff-run");
	assert.equal(activeKickoffRunId(), "kb-dev-kickoff-run");

	// A kb_agent call the main agent makes inside the window inherits the
	// window's runId (FR-27): no explicit runId, still recorded with it.
	await executeKbAgent({
		agent: "kb-developer",
		task: "implement KB-42",
		config: {},
		session: {},
		runSubagent: async () => roundResult("kb-developer"),
		ledgerPath,
	});

	const records = readRecords(ledgerPath);
	assert.equal(records.length, 1);
	assert.equal(records[0].runId, "kb-dev-kickoff-run");
	assert.equal(records[0].agent, "kb-developer");
	assert.equal(records[0].item, "KB-42");

	// Once the window is closed, calls fall back to their own per-call id.
	closeKickoffWindow();
	assert.equal(activeKickoffRunId(), null);
	await executeKbAgent({
		agent: "kb-reviewer",
		task: "review KB-42",
		config: {},
		session: {},
		runSubagent: async () => roundResult("kb-reviewer"),
		ledgerPath,
	});
	assert.equal(readRecords(ledgerPath).length, 2);
	assert.match(readRecords(ledgerPath)[1].runId, /^kb-agent-/);
});

test("agent_settled emits the \"Usage this run\" block for the window's records and closes the window", (t) => {
	const dir = tmpDir();
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		closeKickoffWindow();
	});
	const ledgerPath = path.join(dir, ".pi", "kb-usage.jsonl");

	// The window's records: one sweep round plus one kickoff round, both
	// attributed to the kickoff runId — and a foreign record that must not
	// leak into the block.
	openKickoffWindow("kb-dev-kickoff-run");
	appendRecord(ledgerPath, record("kb-dev-kickoff-run", "kb-reviewer", 0.5));
	appendRecord(ledgerPath, record("kb-dev-kickoff-run", "kb-developer", 1.25));
	appendRecord(ledgerPath, record("kb-agent-other", "kb-developer", 98.76));

	const { appended, appendEntry } = captureAppend();
	settleKickoffWindow({ cwd: dir, appendEntry });

	// Exactly one entry, on the dedicated TUI-only type, rendering the
	// "Usage this run" block for the window's records (FR-29/FR-30).
	assert.equal(appended.length, 1);
	assert.equal(appended[0].type, USAGE_ENTRY_TYPE);
	const markdown = (appended[0].data as UsageEntryData).markdown;
	assert.ok(markdown.includes("**Usage this run**"), markdown);
	// Per-role breakdown in order of first appearance (the sweep reviewer
	// round ran before the kickoff developer round).
	assert.ok(markdown.includes("- cost: **€1.75** — reviewer €0.50 · developer €1.25"), markdown);
	assert.ok(!markdown.includes("98.76"), markdown);

	// The window is closed: a second settle emits nothing.
	assert.equal(activeKickoffRunId(), null);
	const second = captureAppend();
	settleKickoffWindow({ cwd: dir, appendEntry: second.appendEntry });
	assert.equal(second.appended.length, 0);
});

test("a window that recorded no rounds emits no usage block", (t) => {
	const dir = tmpDir();
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		closeKickoffWindow();
	});

	// The window is open but no round was recorded under its runId.
	openKickoffWindow("kb-dev-kickoff-run");
	const { appended, appendEntry } = captureAppend();
	settleKickoffWindow({ cwd: dir, appendEntry });

	assert.equal(appended.length, 0);
	assert.equal(activeKickoffRunId(), null);
});

test("after an extension reload the window is gone, rounds get per-call ids and no block is emitted", async (t) => {
	const dir = tmpDir();
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		closeKickoffWindow();
	});
	const ledgerPath = path.join(dir, ".pi", "kb-usage.jsonl");

	// The window is open in this module instance...
	openKickoffWindow("kb-dev-kickoff-run");

	// ...but an extension reload produces a fresh module instance whose
	// in-memory window is gone (acceptable degradation, FR-29): the reloaded
	// module has no active kickoff and its settle emits no block.
	const reloaded = await import(`./kickoff-window.ts?reload-${Math.random()}`);
	assert.equal(reloaded.activeKickoffRunId(), null);
	const reloadedAppend = captureAppend();
	reloaded.settleKickoffWindow({ cwd: dir, appendEntry: reloadedAppend.appendEntry });
	assert.equal(reloadedAppend.appended.length, 0);

	// Rounds made with no window open get their own per-call ids (FR-27):
	// the reload's rounds cannot be attributed to the lost run.
	closeKickoffWindow();
	await executeKbAgent({
		agent: "kb-developer",
		task: "implement KB-42",
		config: {},
		session: {},
		runSubagent: async () => roundResult("kb-developer"),
		ledgerPath,
	});
	const records = readRecords(ledgerPath);
	assert.equal(records.length, 1);
	assert.match(records[0].runId, /^kb-agent-/);

	// And the lost window never emits a block: settling this module instance
	// (whose window was closed above, as the reload would have lost it)
	// emits nothing for the per-call round.
	const settleAppend = captureAppend();
	settleKickoffWindow({ cwd: dir, appendEntry: settleAppend.appendEntry });
	assert.equal(settleAppend.appended.length, 0);
});
