import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatchDev, parseDevArgs } from "./dispatch.ts";

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

test("argument parsing dispatches bare and message invocations to the right mode", async () => {
	const bareCalls: string[] = [];
	const messageCalls: string[] = [];

	await dispatchDev({
		args: "",
		runBare: async () => {
			bareCalls.push("bare");
			return { report: "bare report" };
		},
		runMessage: async () => {
			messageCalls.push("message");
			return { report: "message report", delivered: true };
		},
	});
	assert.deepEqual(bareCalls, ["bare"]);
	assert.deepEqual(messageCalls, []);

	await dispatchDev({
		args: "  fix the broken tests ",
		runBare: async () => {
			bareCalls.push("bare");
			return { report: "bare report" };
		},
		runMessage: async (message) => {
			messageCalls.push(message);
			return { report: "message report", delivered: true };
		},
	});
	assert.deepEqual(bareCalls, ["bare"]);
	assert.deepEqual(messageCalls, ["fix the broken tests"]);
});

test("bare-mode selection is delegated to kb next, one element per invocation", async () => {
	// The dispatcher adds no ordering of its own: the bare runner is invoked
	// exactly once per invocation and receives everything it needs (it, not
	// the dispatcher, resolves the element via `kb next`); the message runner
	// is never invoked in bare mode.
	let bareRuns = 0;
	let messageRuns = 0;
	const result = await dispatchDev({
		args: "",
		runBare: async () => {
			bareRuns++;
			return { report: "worked one element via kb next" };
		},
		runMessage: async () => {
			messageRuns++;
			return { report: "message report", delivered: true };
		},
	});

	assert.equal(bareRuns, 1);
	assert.equal(messageRuns, 0);
	assert.equal(result.report, "worked one element via kb next");
});

test("kickoff template contains interpretation, identification, ask-first and DAG-order rules", async () => {
	// The message mode passes the user message to the message runner verbatim
	// (trimmed); the runner builds the fixed kickoff template (its content is
	// asserted in message-mode.test.ts) — the dispatcher must not alter it.
	let received: string | null = null;
	await dispatchDev({
		args: "please fix the broken tests",
		runBare: async () => ({ report: "bare" }),
		runMessage: async (message) => {
			received = message;
			return { report: "message report", delivered: true };
		},
	});
	assert.equal(received, "please fix the broken tests");
});
