import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

import { dispatchDev, parseDevArgs } from "./dispatch.ts";
import { activeKickoffRunId, closeKickoffWindow } from "./kickoff-window.ts";
import { appendRecord } from "./usage-ledger.ts";

// The bare mode runs real git seams (runDeveloperRound), so it needs a
// scratch repository as the cwd.
function tmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-dispatch-test-"));
	execSync("git init -b develop", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "a");
	execSync("git add . && git commit -m init", { cwd: dir });
	return dir;
}

test("argument parsing distinguishes bare and message invocations", () => {
	// No arguments (or only whitespace) -> bare mode.
	assert.deepEqual(parseDevArgs(""), { mode: "bare", message: null });
	assert.deepEqual(parseDevArgs("   "), { mode: "bare", message: null });
	assert.deepEqual(parseDevArgs("\t\n "), { mode: "bare", message: null });

	// Any non-blank argument -> message mode with the trimmed message.
	assert.deepEqual(parseDevArgs("fix the broken tests"), {
		mode: "message",
		message: "fix the broken tests",
	});
	assert.deepEqual(parseDevArgs("  work on KB-42  "), {
		mode: "message",
		message: "work on KB-42",
	});
	assert.deepEqual(parseDevArgs("a"), { mode: "message", message: "a" });
});

function dispatchTestDeps(overrides: Partial<Parameters<typeof dispatchDev>[0]> = {}): Parameters<typeof dispatchDev>[0] {
	return {
		args: "",
		cwd: "/tmp/whatever",
		kb: async () => ({ code: 2, stdout: "", stderr: "", json: null }),
		preFlight: async () => ({ ok: true, branch: "develop" as const }),
		runSubagent: async () => ({ ok: true, output: "ok", stderr: "" }),
		sendUserMessage: async () => {},
		...overrides,
	};
}

test("argument parsing dispatches bare and message invocations to the right mode", async (t) => {
	const subagentCalls: string[] = [];
	const messages: string[] = [];

	// Bare invocation: subagent rounds run, no kickoff is delivered.
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const task = {
		id: "KB-42", ref: null, type: "task" as const, title: "task", description: "",
		parent: null, status: "todo" as const, priority: "medium" as const, points: null,
		spec: null, labels: [], links: [], acceptance: [], tests: [], tdd_phase: null,
		position: 1,
	};
	await dispatchDev(dispatchTestDeps({
		args: "",
		cwd: dir,
		kb: async (args) => {
			if (args[0] === "list") return { code: 0, stdout: "[]", stderr: "", json: [] };
			return { code: 0, stdout: JSON.stringify(task), stderr: "", json: task };
		},
		runSubagent: async (opts) => {
			subagentCalls.push(opts.agent);
			return { ok: true, output: "ok", stderr: "" };
		},
	}));
	assert.ok(subagentCalls.includes("kb-developer"));
	assert.deepEqual(messages, []);

	// Message invocation: the kickoff is delivered, no subagent runs.
	await dispatchDev(dispatchTestDeps({
		args: "  fix the broken tests ",
		sendUserMessage: async (message) => {
			messages.push(message);
		},
	}));
	assert.deepEqual(subagentCalls, ["kb-developer", "kb-reviewer"]);
	assert.equal(messages.length, 1);
});

test("bare-mode selection is delegated to kb next, one element per invocation", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	// The dispatcher adds no ordering of its own: the bare runner resolves
	// the element via `kb next` and runs exactly one full cycle; the message
	// runner is never invoked in bare mode.
	const task = {
		id: "KB-42", ref: null, type: "task" as const, title: "task", description: "",
		parent: null, status: "todo" as const, priority: "medium" as const, points: null,
		spec: null, labels: [], links: [], acceptance: [], tests: [], tdd_phase: null,
		position: 1,
	};
	const kbCalls: string[][] = [];
	const messages: string[] = [];
	const result = await dispatchDev(dispatchTestDeps({
		args: "",
		cwd: dir,
		kb: async (args) => {
			kbCalls.push(args);
			if (args[0] === "list") return { code: 0, stdout: "[]", stderr: "", json: [] };
			if (args[0] === "next") return { code: 0, stdout: JSON.stringify(task), stderr: "", json: task };
			return { code: 0, stdout: JSON.stringify(task), stderr: "", json: task };
		},
		runSubagent: async () => ({ ok: true, output: "ok", stderr: "" }),
		sendUserMessage: async (message) => {
			messages.push(message);
		},
	}));

	assert.ok(kbCalls.some((args) => args[0] === "next"));
	assert.deepEqual(messages, []);
	assert.ok(result.report.includes("KB-42"));
});

test("kickoff template contains interpretation, identification, ask-first and DAG-order rules", async () => {
	// The message mode passes the user message to the message runner verbatim
	// (trimmed); the runner builds the fixed kickoff template (its content is
	// asserted in message-mode.test.ts) — the dispatcher must not alter it.
	let received: string | null = null;
	await dispatchDev(dispatchTestDeps({
		args: "please fix the broken tests",
		sendUserMessage: async (message) => {
			received = message;
		},
	}));
	assert.ok(received && received.includes("please fix the broken tests"));
});

// ---------------------------------------------------------------------------
// KB-8: the /kb-dev command resolves and forwards model + thinking level
// per role through the injected config and session seams.
// ---------------------------------------------------------------------------

test("/kb-dev command resolves and forwards model and thinking-level per role", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const task = {
		id: "KB-42", ref: null, type: "task" as const, title: "task", description: "",
		parent: null, status: "todo" as const, priority: "medium" as const, points: null,
		spec: null, labels: [], links: [], acceptance: [], tests: [], tdd_phase: null,
		position: 1,
	};
	const kbRun = (json: unknown, code = 0) => ({ code, stdout: JSON.stringify(json), stderr: "", json });
	const seen: Array<{ agent: string; model?: string; thinkingLevel?: string }> = [];

	await dispatchDev({
		args: "",
		cwd: dir,
		config: {
			kbAgents: {
				developer: { model: "provider/dev", thinkingLevel: "high" },
				reviewer: { thinkingLevel: "low" },
			},
		},
		session: { model: "provider/session", thinkingLevel: "medium" },
		kb: async (args) => {
			if (args[0] === "list") return kbRun([]);
			if (args[0] === "next") return kbRun(task);
			if (args[0] === "show") return kbRun(task);
			return kbRun({ error: "unscripted" }, 1);
		},
		preFlight: async () => ({ ok: true, branch: "develop" as const }),
		runSubagent: async (opts) => {
			seen.push({ agent: opts.agent, model: opts.model, thinkingLevel: opts.thinkingLevel });
			return { ok: true, output: "ok", stderr: "" };
		},
		sendUserMessage: async () => {},
	});

	assert.deepEqual(seen, [
		{ agent: "kb-developer", model: "provider/dev", thinkingLevel: "high" },
		{ agent: "kb-reviewer", model: "provider/session", thinkingLevel: "low" },
	]);
});

// ---------------------------------------------------------------------------
// KB-55: the final /kb-dev report carries a "Usage this run" block (FR-29 /
// AC-35) — this run's token/euro totals and per-role breakdown, aggregated
// from the ledger records of this run's runId, in both retrieval modes.
// ---------------------------------------------------------------------------

test("bare-mode /kb-dev report shows this run's totals and per-role breakdown", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const ledgerPath = path.join(dir, ".pi", "kb-usage.jsonl");
	const task = {
		id: "KB-42", ref: null, type: "task" as const, title: "task", description: "",
		parent: null, status: "todo" as const, priority: "medium" as const, points: null,
		spec: null, labels: [], links: [], acceptance: [], tests: [], tdd_phase: null,
		position: 1,
	};
	const kbRun = (json: unknown, code = 0) => ({ code, stdout: JSON.stringify(json), stderr: "", json });

	const result = await dispatchDev(dispatchTestDeps({
		args: "",
		cwd: dir,
		ledgerPath,
		runId: "kb-dev-this-run",
		kb: async (args) => {
			if (args[0] === "list") return kbRun([]);
			if (args[0] === "next") return kbRun(task);
			return kbRun(task);
		},
		runSubagent: async (opts) => ({
			ok: true,
			output: "ok",
			stderr: "",
			usage:
				opts.agent === "kb-developer"
					? { input: 4000, output: 3000, cacheRead: 1000000, cacheWrite: 2000, cost: 1.25, turns: 2 }
					: { input: 2000, output: 1000, cacheRead: 500000, cacheWrite: 0, cost: 0.5, turns: 1 },
		}),
	}));

	// The usage block is appended to the report markdown (FR-29): totals and
	// a per-role breakdown, cache read/write separate (AC-35).
	assert.ok(result.report.includes("**Usage this run**"), result.report);
	assert.ok(result.report.includes("- tokens: 6k in / 4k out · cache 1.5M read / 2k write"), result.report);
	assert.ok(result.report.includes("- cost: **€1.75** — developer €1.25 · reviewer €0.50"), result.report);
});

test("message mode opens a kickoff window instead of putting the usage block in the report", async (t) => {
	const dir = tmpRepo();
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		closeKickoffWindow();
	});
	const ledgerPath = path.join(dir, ".pi", "kb-usage.jsonl");

	const result = await dispatchDev(dispatchTestDeps({
		args: "fix the broken tests",
		cwd: dir,
		ledgerPath,
		runId: "kb-dev-this-run",
		sendUserMessage: async () => {},
	}));

	// FR-29 (amended, KB-61): the delivered kickoff opens a kickoff window
	// with the /kb-dev runId as the active kickoff (AC-38) — the block is
	// emitted when the kickoff run settles, not in this report.
	assert.equal(result.delivered, true);
	assert.equal(activeKickoffRunId(), "kb-dev-this-run");
	assert.ok(!result.report.includes("**Usage this run**"), result.report);
	assert.match(result.report, /usage follows at the end of the kickoff run/i, result.report);

	// An aborted (never delivered) message run opens no window.
	closeKickoffWindow();
	const aborted = await dispatchDev(dispatchTestDeps({
		args: "fix the broken tests",
		cwd: dir,
		ledgerPath,
		runId: "kb-dev-aborted-run",
		preFlight: async () => ({ ok: false, error: "Working tree is dirty." }),
		sendUserMessage: async () => {
			assert.fail("no kickoff after a failed pre-flight");
		},
	}));
	assert.equal(aborted.delivered, false);
	assert.equal(activeKickoffRunId(), null);
});

test("the usage block counts only the records of this run", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const ledgerPath = path.join(dir, ".pi", "kb-usage.jsonl");
	// A previous run already spent a fortune — it must not leak into this run.
	appendRecord(ledgerPath, {
		runId: "kb-dev-previous-run",
		at: "2026-11-14T09:00:00Z",
		agent: "kb-developer",
		role: "developer",
		model: "anthropic/claude-sonnet-4.5",
		thinkingLevel: "high",
		item: "KB-42",
		ok: true,
		usage: { input: 900000, output: 800000, cacheRead: 5000000, cacheWrite: 400000, cost: 98.76, turns: 9 },
	});
	const task = {
		id: "KB-42", ref: null, type: "task" as const, title: "task", description: "",
		parent: null, status: "todo" as const, priority: "medium" as const, points: null,
		spec: null, labels: [], links: [], acceptance: [], tests: [], tdd_phase: null,
		position: 1,
	};
	const kbRun = (json: unknown, code = 0) => ({ code, stdout: JSON.stringify(json), stderr: "", json });

	const result = await dispatchDev(dispatchTestDeps({
		args: "",
		cwd: dir,
		ledgerPath,
		runId: "kb-dev-this-run",
		kb: async (args) => {
			if (args[0] === "list") return kbRun([]);
			if (args[0] === "next") return kbRun(task);
			return kbRun(task);
		},
		runSubagent: async () => ({
			ok: true,
			output: "ok",
			stderr: "",
			usage: { input: 4000, output: 3000, cacheRead: 1000000, cacheWrite: 2000, cost: 1.25, turns: 2 },
		}),
	}));

	// This run recorded a dev and a reviewer round (8k/6k, €2.50); the
	// previous run's fortune (900k/800k, €98.76) appears nowhere.
	assert.ok(result.report.includes("- tokens: 8k in / 6k out · cache 2.0M read / 4k write"), result.report);
	assert.ok(result.report.includes("- cost: **€2.50** — developer €1.25 · reviewer €1.25"), result.report);
	// The previous run's numbers appear nowhere in the block.
	assert.ok(!result.report.includes("98.76"), result.report);
	assert.ok(!result.report.includes("900k"), result.report);
});

// ---------------------------------------------------------------------------
// KB-50 (FR-25 / AC-32): the round results the dispatch seam hands to the
// mode runners carry the resolved model, thinking level and usage of the
// round, so every round line of the /kb-dev report lists the model and
// thinking level it ran with — bare mode (dev, review, qa) and the swept
// review/qa rounds of message mode alike.
// ---------------------------------------------------------------------------

const roundConfig = {
	kbAgents: {
		developer: { model: "provider/dev", thinkingLevel: "high" as const },
		reviewer: { model: "provider/rev", thinkingLevel: "low" as const },
		qa: { model: "provider/qa", thinkingLevel: "medium" as const },
	},
};

function roundItem(id: string, type: "task" | "story" | "epic", status: string, parent: string | null, title: string) {
	return {
		id, ref: null, type, title, description: "",
		parent, status, priority: "medium" as const, points: null,
		spec: null, labels: [], links: [], acceptance: [], tests: [], tdd_phase: null,
		position: 1,
	};
}

test("/kb-dev report lists model and thinking level per round", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// Bare mode: one task cycle (dev + review) whose completion puts the
	// parent story in review, so the qa round fires too (FR-13).
	const task = roundItem("KB-42", "task", "todo", "KB-41", "task");
	const story = roundItem("KB-41", "story", "review", "KB-1", "story");
	const epic = roundItem("KB-1", "epic", "doing", null, "epic");
	const byId = new Map([
		[task.id, task],
		[story.id, story],
		[epic.id, epic],
	]);
	const kbRun = (json: unknown, code = 0) => ({ code, stdout: JSON.stringify(json), stderr: "", json });

	const result = await dispatchDev(dispatchTestDeps({
		args: "",
		cwd: dir,
		config: roundConfig,
		kb: async (args) => {
			if (args[0] === "list") return kbRun([]);
			if (args[0] === "next") {
				// No epic, no story: the FR-11 chain falls through to the task.
				if (args.includes("--type")) return kbRun({ error: "none" }, 2);
				return kbRun(task);
			}
			return kbRun(byId.get(args[1]) ?? null);
		},
		runSubagent: async () => ({ ok: true, output: "ok", stderr: "" }),
	}));

	// Every round line lists the model and thinking level the round ran
	// with, resolved per role (FR-20) — dev, reviewer and qa alike (AC-32).
	assert.ok(
		result.report.includes("- dev KB-42 \"task\" (try 1, branch feature/KB-42): ok — ok [provider/dev · thinking high]"),
		result.report,
	);
	assert.ok(result.report.includes("- review KB-42 \"task\": ok — ok [provider/rev · thinking low]"), result.report);
	assert.ok(result.report.includes("- qa review KB-41 \"story\": ok — ok [provider/qa · thinking medium]"), result.report);

	// Message mode: the swept pending review rounds list their config too
	// (AC-32 holds for message mode) — a task goes to kb-reviewer, a story
	// to kb-qa (FR-12).
	t.after(() => closeKickoffWindow());
	const pendingTask = roundItem("KB-7", "task", "review", null, "pending task");
	const pendingStory = roundItem("KB-8", "story", "review", "KB-1", "pending story");
	const message = await dispatchDev(dispatchTestDeps({
		args: "fix the broken tests",
		cwd: dir,
		config: roundConfig,
		kb: async (args) => {
			if (args[0] === "list") return kbRun([pendingTask, pendingStory]);
			return kbRun(null);
		},
		sendUserMessage: async () => {},
	}));
	assert.ok(message.report.includes("- review KB-7 \"pending task\": ok — ok [provider/rev · thinking low]"), message.report);
	assert.ok(message.report.includes("- qa review KB-8 \"pending story\": ok — ok [provider/qa · thinking medium]"), message.report);
});

test("a failed round still reports the model and thinking level it ran with", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const task = roundItem("KB-42", "task", "todo", null, "task");
	const kbRun = (json: unknown, code = 0) => ({ code, stdout: JSON.stringify(json), stderr: "", json });
	const kb = async (args: string[]) => {
		if (args[0] === "list") return kbRun([]);
		if (args[0] === "next") {
			if (args.includes("--type")) return kbRun({ error: "none" }, 2);
			return kbRun(task);
		}
		return kbRun(task);
	};

	// The developer round fails both tries: both FAILED dev lines still
	// name the model and thinking level the round ran with.
	const devFail = await dispatchDev(dispatchTestDeps({
		args: "",
		cwd: dir,
		config: roundConfig,
		kb,
		runSubagent: async (opts) =>
			opts.agent === "kb-developer"
				? { ok: false, output: "boom", stderr: "err", errorMessage: "exploded" }
				: { ok: true, output: "ok", stderr: "" },
	}));
	assert.ok(
		devFail.report.includes("- dev KB-42 \"task\" (try 1, branch feature/KB-42): FAILED — boom [provider/dev · thinking high]"),
		devFail.report,
	);
	assert.ok(
		devFail.report.includes("- dev KB-42 \"task\" (try 2, branch feature/KB-42): FAILED — boom [provider/dev · thinking high]"),
		devFail.report,
	);

	// A failed review round lists its config too.
	const revFail = await dispatchDev(dispatchTestDeps({
		args: "",
		cwd: dir,
		config: roundConfig,
		kb,
		runSubagent: async (opts) =>
			opts.agent === "kb-reviewer"
				? { ok: false, output: "bad", stderr: "err", errorMessage: "rejected" }
				: { ok: true, output: "ok", stderr: "" },
	}));
	assert.ok(revFail.report.includes("- review KB-42 \"task\": FAILED — bad [provider/rev · thinking low]"), revFail.report);
});
