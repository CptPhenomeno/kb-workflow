/**
 * FR-28 / AC-34 / NFR-15 — every subagent round is persisted to the usage
 * ledger from both spawn paths: the /kb-dev orchestration rounds (via
 * dispatchDev) and every kb_agent tool invocation (via executeKbAgent),
 * successful or failed, and a ledger write failure never fails anything.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { test } from "node:test";

import { dispatchDev } from "./dispatch.ts";
import { executeKbAgent } from "./agent-tool.ts";
import { readRecords } from "./usage-ledger.ts";
import { actorForAgent } from "./subagent.ts";
import type { KbWorkflowConfig, SessionFallbacks } from "./config.ts";
import type { KbItem, KbRun } from "./kb.ts";
import type { AgentRoundResult } from "./bare-mode.ts";
import type { KbAgentName, SubagentResult } from "./subagent.ts";

// The bare mode runs real git seams (runDeveloperRound), so it needs a
// scratch repository as the cwd.
function tmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-round-ledger-test-"));
	execSync("git init -b develop", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "a");
	execSync("git add . && git commit -m init", { cwd: dir });
	return dir;
}

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "kb-round-ledger-dir-"));
}

function taskItem(id = "KB-42"): KbItem {
	return {
		id, ref: null, type: "task" as const, title: "task", description: "",
		parent: null, status: "todo" as const, priority: "medium" as const, points: null,
		spec: null, labels: [], links: [], acceptance: [], tests: [], tdd_phase: null,
		position: 1,
	};
}

const USAGE = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.02, turns: 2 };

/** A successful orchestration round as the real runSubagent seam returns it. */
function roundResult(overrides: Partial<AgentRoundResult> = {}): AgentRoundResult {
	return { ok: true, output: "ok", stderr: "", usage: { ...USAGE }, ...overrides };
}

/** A full SubagentResult as the real runner returns for the kb_agent tool. */
function toolResult(agent: KbAgentName): SubagentResult {
	return {
		ok: true,
		agent,
		actor: "agent-test",
		output: "ok",
		stderr: "",
		exitCode: 0,
		usage: { ...USAGE },
	};
}

const CONFIG: KbWorkflowConfig = {
	kbAgents: {
		developer: { model: "provider/dev", thinkingLevel: "high" },
		reviewer: { model: "provider/rev", thinkingLevel: "low" },
	},
};

const SESSION: SessionFallbacks = { model: "provider/session", thinkingLevel: "medium" };

/** kb stub for a bare run over exactly one task: empty board, then KB-42. */
function kbFor(task: KbItem) {
	return async (args: string[]): Promise<KbRun> => {
		if (args[0] === "list") return { code: 0, stdout: "[]", stderr: "", json: [] };
		return { code: 0, stdout: JSON.stringify(task), stderr: "", json: task };
	};
}

function dispatchDeps(cwd: string, runSubagent: Parameters<typeof dispatchDev>[0]["runSubagent"]) {
	return {
		args: "",
		cwd,
		config: CONFIG,
		session: SESSION,
		kb: kbFor(taskItem()),
		preFlight: async () => ({ ok: true, branch: "develop" as const }),
		runSubagent,
		sendUserMessage: async () => {},
	};
}

test("each subagent round is persisted to the ledger with role, model, tokens and cost", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const spawns: string[] = [];
	await dispatchDev(dispatchDeps(dir, async (opts) => {
		spawns.push(opts.agent);
		return roundResult();
	}));

	// The full cycle ran: one developer round and one reviewer round.
	assert.deepEqual(spawns, ["kb-developer", "kb-reviewer"]);

	const records = readRecords(path.join(dir, ".pi", "kb-usage.jsonl"));
	assert.equal(records.length, 2, "one ledger record per round");

	const [dev, rev] = records;
	assert.equal(dev.role, "developer");
	assert.equal(dev.model, "provider/dev");
	assert.equal(dev.thinkingLevel, "high");
	assert.equal(dev.item, "KB-42");
	// FR-27 (amended): `agent` is the subagent name, no item suffix.
	assert.equal(dev.agent, "kb-developer");
	assert.ok(dev.runId.length > 0, "the record carries the /kb-dev invocation id");
	assert.equal(dev.ok, true);
	assert.deepEqual(dev.usage, USAGE);

	assert.equal(rev.role, "reviewer");
	assert.equal(rev.model, "provider/rev");
	assert.equal(rev.thinkingLevel, "low");
	assert.equal(rev.item, "KB-42");
	assert.equal(rev.ok, true);
	assert.deepEqual(rev.usage, USAGE);

	// Both rounds belong to the same /kb-dev invocation.
	assert.equal(rev.runId, dev.runId);
});

test("a failed round is recorded with ok false", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// The developer round succeeds, the reviewer round fails: the failed
	// round is recorded too (FR-28) and the run still completes.
	const result = await dispatchDev(dispatchDeps(dir, async (opts) =>
		opts.agent === "kb-reviewer"
			? roundResult({ ok: false, output: "nope", stderr: "", errorMessage: "boom" })
			: roundResult(),
	));

	const records = readRecords(path.join(dir, ".pi", "kb-usage.jsonl"));
	assert.equal(records.length, 2);
	assert.equal(records[0].ok, true);
	assert.equal(records[1].ok, false);
	assert.equal(records[1].role, "reviewer");
	assert.equal(records[1].usage.cost, USAGE.cost, "the failed round's spend is recorded");
	assert.ok(result.report.length > 0, "the run completes despite the failed round");
});

test("a kb_agent tool invocation is recorded with its own runId and item null when it targets no item", async (t) => {
	const dir = tmpDir();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const ledgerPath = path.join(dir, ".pi", "kb-usage.jsonl");

	const run = (task: string) =>
		executeKbAgent({
			agent: "kb-developer",
			task,
			config: CONFIG,
			session: SESSION,
			ledgerPath,
			runSubagent: async (opts) => toolResult(opts.agent),
		});

	await run("implement KB-8 end to end");
	await run("do something with no item at all");

	const records = readRecords(ledgerPath);
	assert.equal(records.length, 2, "one ledger record per kb_agent invocation");

	const [withItem, withoutItem] = records;
	assert.equal(withItem.item, "KB-8", "the targeted kb item is recorded");
	assert.equal(withoutItem.item, null, "no targeted item is recorded as null");
	// The `agent` field is the subagent name regardless of the item.
	assert.equal(withItem.agent, "kb-developer");
	assert.equal(withoutItem.agent, "kb-developer");
	assert.notEqual(withItem.runId, withoutItem.runId, "each kb_agent call has its own runId");

	assert.equal(withItem.role, "developer");
	assert.equal(withItem.model, "provider/dev");
	assert.equal(withItem.thinkingLevel, "high");
	assert.equal(withItem.ok, true);
	assert.deepEqual(withItem.usage, USAGE);
});

test("a ledger record's agent field is the subagent name with no item suffix", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	await dispatchDev(dispatchDeps(dir, async () => roundResult()));

	const records = readRecords(path.join(dir, ".pi", "kb-usage.jsonl"));
	const agents = records.map((r) => r.agent);
	assert.deepEqual(agents, ["kb-developer", "kb-reviewer"],
		"agent is the bare subagent name, no actor prefix and no -<item> suffix");
});

test("the claim actor is not stored in the record and is recomputable from agent plus item", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	await dispatchDev(dispatchDeps(dir, async () => roundResult()));

	const records = readRecords(path.join(dir, ".pi", "kb-usage.jsonl"));
	assert.equal(records.length, 2);

	// No field stores the claim actor: the record shape is exactly FR-27.
	const persisted = fs.readFileSync(path.join(dir, ".pi", "kb-usage.jsonl"), "utf8")
		.split("\n").filter(Boolean).map((line) => Object.keys(JSON.parse(line)));
	assert.ok(persisted.every((keys) => !keys.includes("actor") && !keys.includes("claimActor")));

	// The claim actor is recomputable from `agent` + `item` (AC-40).
	const [dev, rev] = records;
	assert.equal(`${actorForAgent(dev.agent as KbAgentName)}-${dev.item}`, "agent-dev-KB-42");
	assert.equal(`${actorForAgent(rev.agent as KbAgentName)}-${rev.item}`, "agent-review-KB-42");
});

test("index.ts wires the kb_agent ledger through ledgerPathFor so the FR-27 location has one source of truth", () => {
	const indexTs = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");
	// The FR-27 location is defined once, in lib/round-ledger.ts (finding B).
	assert.ok(indexTs.includes('ledgerPathFor(ctx.cwd)'),
		"index.ts must call ledgerPathFor(ctx.cwd) for the kb_agent ledger");
	assert.ok(!indexTs.includes('kb-usage.jsonl'),
		"index.ts must not inline the ledger path");
});

test("a ledger write failure does not fail the round or the /kb-dev run", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	// An unwritable ledger: a directory where the JSONL file would go, so
	// every append fails (NFR-15 must swallow it).
	const brokenLedger = path.join(dir, ".pi", "kb-usage.jsonl");
	fs.mkdirSync(brokenLedger, { recursive: true });

	// The orchestration run completes with all its rounds.
	const spawns: string[] = [];
	const result = await dispatchDev(dispatchDeps(dir, async (opts) => {
		spawns.push(opts.agent);
		return roundResult();
	}));
	assert.deepEqual(spawns, ["kb-developer", "kb-reviewer"], "both rounds ran");
	assert.ok(result.report.includes("KB-42"), "the run produced its report");

	// The kb_agent tool path completes too and returns its result.
	const res = await executeKbAgent({
		agent: "kb-reviewer",
		task: "review KB-42",
		config: CONFIG,
		session: SESSION,
		ledgerPath: brokenLedger,
		runSubagent: async (opts) => toolResult(opts.agent),
	});
	// executeKbAgent returns the round's result plus the resolved config and
	// streamed lines (FR-24); the ledger failure still never fails the round.
	assert.equal(res.result.ok, true, "the kb_agent round is unaffected by the ledger failure");
});
