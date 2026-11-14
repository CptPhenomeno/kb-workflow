import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

import { devKickoff, runMessageDev } from "./message-mode.ts";
import { closeKickoffWindow } from "./kickoff-window.ts";
import type { KbItem, KbRun } from "./kb.ts";

function tmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-msg-test-"));
	execSync("git init -b develop", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "a");
	execSync("git add . && git commit -m init", { cwd: dir });
	return dir;
}

function item(id: string, status: KbItem["status"]): KbItem {
	return {
		id,
		ref: null,
		type: "task",
		title: `item ${id}`,
		description: "",
		parent: "KB-1",
		status,
		priority: "medium",
		points: null,
		spec: null,
		labels: [],
		links: [],
		acceptance: [],
		tests: [],
		tdd_phase: null,
		position: 1,
	} as KbItem;
}

function kbRun(json: unknown, code = 0): KbRun {
	return { code, stdout: JSON.stringify(json), stderr: "", json };
}

function fakeKb(responses: Map<string, (args: string[]) => KbRun>, calls: string[][]) {
	return async (args: string[]): Promise<KbRun> => {
		calls.push(args);
		const handler = responses.get(args[0]);
		if (!handler) return kbRun({ error: "unscripted", message: args.join(" ") }, 1);
		return handler(args);
	};
}

test("message mode runs the pre-flight before delivering the kickoff", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const events: string[] = [];
	const result = await runMessageDev({
		cwd: dir,
		message: "fix the build",
		kb: fakeKb(new Map([["list", () => kbRun([])]]), []),
		preFlight: async () => {
			events.push("pre-flight");
			return { ok: true, branch: "develop" as const };
		},
		spawnReviewer: async (i) => {
			events.push(`review ${i.id}`);
			return { ok: true, output: "ok", stderr: "" };
		},
		sendUserMessage: async (msg) => {
			events.push("kickoff");
			assert.ok(msg.includes("fix the build"));
		},
	});

	assert.deepEqual(events, ["pre-flight", "kickoff"]);
	assert.equal(result.delivered, true);
});

test("message mode aborts on a dirty tree without delivering the kickoff", async (t) => {
	const dir = tmpRepo();
	fs.writeFileSync(path.join(dir, "dirty.txt"), "x");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	let delivered = false;
	const result = await runMessageDev({
		cwd: dir,
		message: "anything",
		kb: async () => {
			assert.fail("kb must not run after a failed pre-flight");
		},
		preFlight: async () => ({ ok: false, error: "Working tree is dirty." }),
		spawnReviewer: async () => {
			assert.fail("no reviewer round after a failed pre-flight");
			throw new Error("unreachable");
		},
		sendUserMessage: async () => {
			delivered = true;
		},
	});

	assert.equal(result.delivered, false);
	assert.equal(delivered, false);
	assert.match(result.report, /dirty/i);
});

test("kickoff template covers interpretation, identification, ask-first and DAG order", () => {
	const kickoff = devKickoff("please fix the broken tests");
	assert.match(kickoff, /please fix the broken tests/);
	// Interpretation: the message is operational instructions, not an idea to plan.
	assert.match(kickoff, /operational instructions/i);
	// Identification: by ID/ref or by matching titles, descriptions and test
	// states — generic requests must work.
	assert.match(kickoff, /ID|ref/i);
	assert.match(kickoff, /titles?, descriptions and test states/i);
	assert.match(kickoff, /generic requests/i);
	// Ask-first rule: ask_user before touching the board when ambiguous.
	assert.match(kickoff, /ask_user/);
	assert.match(kickoff, /ambiguous|maps to no item/i);
	assert.match(kickoff, /before (any|touching|making).*(board|git|change)/i);
	// DAG order through the standard pipeline.
	assert.match(kickoff, /DAG order/i);
	assert.match(kickoff, /kb_agent/);
	assert.match(kickoff, /kb-developer/);
	assert.match(kickoff, /kb-reviewer/);
	assert.match(kickoff, /branch per task/i);
	assert.match(kickoff, /final report/i);
});

test("message mode completes pending reviews before the kickoff", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const pending = [item("KB-9", "review"), item("KB-4", "review")];
	const reviewed: string[] = [];
	const events: string[] = [];
	const calls: string[][] = [];
	const result = await runMessageDev({
		cwd: dir,
		message: "work on the login story",
		kb: fakeKb(new Map([["list", () => kbRun(pending)]]), calls),
		preFlight: async () => {
			events.push("pre-flight");
			return { ok: true, branch: "develop" as const };
		},
		spawnReviewer: async (i) => {
			events.push(`review ${i.id}`);
			reviewed.push(i.id);
			return { ok: true, output: "done", stderr: "" };
		},
		sendUserMessage: async () => {
			events.push("kickoff");
		},
	});

	// Same deterministic order as the bare mode: board position, then id.
	assert.deepEqual(reviewed, ["KB-4", "KB-9"]);
	// The board was listed for review items before the kickoff was delivered.
	assert.deepEqual(events, ["pre-flight", "review KB-4", "review KB-9", "kickoff"]);
	assert.equal(result.delivered, true);
	assert.match(result.report, /KB-4/);
	assert.match(result.report, /KB-9/);
	// The handler performs no other board action: only the review listing.
	assert.deepEqual(
		calls.filter((c) => c[0] === "list").map((c) => c.slice(1)),
		[["--status", "review"]],
	);
});

test("message mode neither spawns developers nor runs git actions itself", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const result = await runMessageDev({
		cwd: dir,
		message: "work on KB-42",
		kb: fakeKb(new Map([["list", () => kbRun([])]]), []),
		preFlight: async () => ({ ok: true, branch: "develop" as const }),
		spawnReviewer: async () => {
			assert.fail("no reviewer round when the review column is empty");
			throw new Error("unreachable");
		},
		sendUserMessage: async () => {},
	});

	assert.equal(result.delivered, true);
	// The kickoff is the fixed template plus the user message — nothing else.
	assert.equal(result.kickoff, devKickoff("work on KB-42"));
});

test("kickoff template instructs the main agent to spawn kb-qa for stories/epics reaching review", () => {
	const kickoff = devKickoff("finish the auth story");
	// FR-14: whenever a story or epic reaches review during the
	// message-driven work, a kb-qa round is spawned before finishing.
	assert.match(kickoff, /kb-qa/);
	assert.match(kickoff, /story or an epic|story or epic/i);
	assert.match(kickoff, /reaches? the .review. column/i);
	assert.match(kickoff, /before finishing/i);
	// The kb-qa procedure: spawn via kb_agent, verify merges, delete with -d, never merge.
	assert.match(kickoff, /agent .kb-qa./);
	assert.match(kickoff, /git branch -d/);
	assert.match(kickoff, /never merges/i);
});

test("message mode sweep routes stories/epics to kb-qa and tasks to kb-reviewer", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const story = item("KB-8", "review");
	story.type = "story";
	const epic = item("KB-1", "review");
	epic.type = "epic";
	const task = item("KB-9", "review");
	const pending = [story, epic, task];
	const events: string[] = [];
	await runMessageDev({
		cwd: dir,
		message: "work on the login story",
		kb: fakeKb(new Map([["list", () => kbRun(pending)]]), []),
		preFlight: async () => ({ ok: true, branch: "develop" as const }),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return { ok: true, output: "done", stderr: "" };
		},
		spawnQa: async (i) => {
			events.push(`qa ${i.id}`);
			return { ok: true, output: "qa done", stderr: "" };
		},
		sendUserMessage: async () => {
			events.push("kickoff");
		},
	});

	// Same routing as the bare mode (shared sweep, FR-12): the task goes to
	// kb-reviewer, the story and the epic go to kb-qa — before the kickoff.
	assert.deepEqual(events, ["qa KB-1", "qa KB-8", "reviewer KB-9", "kickoff"]);
});

// ---------------------------------------------------------------------------
// KB-8: per-role model and thinking-level resolution in message mode too.
// ---------------------------------------------------------------------------

test("message-mode round resolves and forwards model and thinking-level per role", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const reviewItem = item("KB-7", "review");
	const seen: Array<{ model?: string; thinkingLevel?: string }> = [];

	await runMessageDev({
		cwd: dir,
		message: "finish the reviews",
		kb: fakeKb(new Map([["list", () => kbRun([reviewItem])]]), []),
		preFlight: async () => ({ ok: true, branch: "develop" as const }),
		config: {
			kbAgents: { reviewer: { model: "provider/rev", thinkingLevel: "low" } },
		},
		session: { model: "provider/session", thinkingLevel: "medium" },
		spawnReviewer: async (_i, resolved) => {
			seen.push({ ...resolved });
			return { ok: true, output: "ok", stderr: "" };
		},
		sendUserMessage: async () => {},
	});

	assert.deepEqual(seen, [{ model: "provider/rev", thinkingLevel: "low" }]);
});

// ---------------------------------------------------------------------------
// KB-51: the kickoff states the resolved per-role dispatch config (FR-26).
// ---------------------------------------------------------------------------

test("message-mode kickoff states the resolved model and thinking level per role", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const result = await runMessageDev({
		cwd: dir,
		message: "work on KB-42",
		kb: fakeKb(new Map([["list", () => kbRun([])]]), []),
		preFlight: async () => ({ ok: true, branch: "develop" as const }),
		spawnReviewer: async () => {
			throw new Error("unreachable");
		},
		config: {
			kbAgents: { developer: { model: "provider/dev", thinkingLevel: "high" } },
		},
		session: { model: "provider/session", thinkingLevel: "medium" },
		sendUserMessage: async () => {},
	});

	assert.equal(result.delivered, true);
	// FR-26 / AC-33: the delivered kickoff states the resolved per-role
	// model and thinking level — the configured developer role shows both.
	assert.match(result.kickoff, /provider\/dev/);
	assert.match(result.kickoff, /thinking high/);
	// The kickoff is still the fixed template plus the message, resolved
	// against the same config and session as the rounds themselves.
	assert.equal(result.kickoff, devKickoff("work on KB-42", {
		config: { kbAgents: { developer: { model: "provider/dev", thinkingLevel: "high" } } },
		session: { model: "provider/session", thinkingLevel: "medium" },
	}));
});

test("the kickoff lists all four roles with their resolved values", () => {
	const kickoff = devKickoff("finish everything", {
		config: {
			kbAgents: {
				planner: { model: "provider/plan", thinkingLevel: "low" },
				developer: { model: "provider/dev", thinkingLevel: "high" },
				reviewer: { model: "provider/rev", thinkingLevel: "medium" },
				qa: { model: "provider/qa", thinkingLevel: "minimal" },
			},
		},
	});

	// All four roles are listed, each with its resolved model and thinking level.
	assert.match(kickoff, /planner: provider\/plan · thinking low/);
	assert.match(kickoff, /developer: provider\/dev · thinking high/);
	assert.match(kickoff, /reviewer: provider\/rev · thinking medium/);
	assert.match(kickoff, /qa: provider\/qa · thinking minimal/);
	// The block states what the values are for (the kb_agent round dispatch).
	assert.match(kickoff, /kb_agent/);
});

test("the kickoff shows the session fallback for a role absent from the config", () => {
	const kickoff = devKickoff("work on the login story", {
		config: {
			kbAgents: { developer: { model: "provider/dev" } },
		},
		session: { model: "provider/session", thinkingLevel: "medium" },
	});

	// A role absent from the config falls back to the dispatching session's
	// values (the same independent per-property fallback as resolveForRole).
	assert.match(kickoff, /planner: provider\/session · thinking medium/);
	assert.match(kickoff, /reviewer: provider\/session · thinking medium/);
	assert.match(kickoff, /qa: provider\/session · thinking medium/);
	// Each property falls back independently: the configured developer model
	// keeps its thinking level from the session.
	assert.match(kickoff, /developer: provider\/dev · thinking medium/);
	// A property that resolved to nothing reads "unknown", the same
	// semantics as the report round lines and the ledger records.
	const bare = devKickoff("work");
	assert.match(bare, /planner: unknown · thinking unknown/);
});

test("the report printed at kickoff delivery states that the usage follows at the end of the kickoff run", async (t) => {
	const dir = tmpRepo();
	t.after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		closeKickoffWindow();
	});

	const result = await runMessageDev({
		cwd: dir,
		message: "work on KB-42",
		kb: fakeKb(new Map([["list", () => kbRun([])]]), []),
		preFlight: async () => ({ ok: true, branch: "develop" as const }),
		spawnReviewer: async () => {
			assert.fail("no reviewer round when the review column is empty");
			throw new Error("unreachable");
		},
		sendUserMessage: async () => {},
	});

	assert.equal(result.delivered, true);
	// FR-29 (amended): in message mode the usage block is emitted when the
	// kickoff run settles, not in this report — the report says so.
	assert.match(result.report, /usage follows at the end of the kickoff run/i, result.report);
	// The block itself is not part of the kickoff-delivery report.
	assert.ok(!result.report.includes("**Usage this run**"), result.report);
});
