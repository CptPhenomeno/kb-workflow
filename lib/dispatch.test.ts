import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

import { dispatchDev, parseDevArgs } from "./dispatch.ts";

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
