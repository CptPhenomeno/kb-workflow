import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

import { runBareDev } from "./bare-mode.ts";
import type { KbItem, KbRun } from "./kb.ts";

function tmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-bare-test-"));
	execSync("git init -b develop", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "a");
	execSync("git add . && git commit -m init", { cwd: dir });
	return dir;
}

function item(id: string, type: KbItem["type"], status: KbItem["status"], parent: string | null = "KB-1"): KbItem {
	return {
		id,
		ref: null,
		type,
		title: `item ${id}`,
		description: "",
		parent,
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

interface ScriptedKb {
	/** All kb invocations, in order (args without --json). */
	calls: string[][];
	/** Scripted responses keyed by first argument. */
	responses: Map<string, (args: string[]) => KbRun>;
}

function fakeKb(script: ScriptedKb) {
	return async (args: string[]): Promise<KbRun> => {
		script.calls.push(args);
		const handler = script.responses.get(args[0]);
		if (!handler) return kbRun({ error: "unscripted", message: args.join(" ") }, 1);
		return handler(args);
	};
}

function okAgent(output: string) {
	return { ok: true, output, stderr: "", errorMessage: undefined };
}

test("bare invocation reviews pending review items before retrieving", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const pending = [item("KB-9", "task", "review"), item("KB-4", "task", "review")];
	const nextItem = item("KB-13", "task", "todo");
	const events: string[] = [];
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			[
				"list",
				(args) => {
					events.push(`kb ${args.join(" ")}`);
					return kbRun(pending);
				},
			],
			[
				"next",
				(args) => {
					events.push(`kb ${args.join(" ")}`);
					return kbRun(nextItem);
				},
			],
			["show", () => kbRun(nextItem)],
		]),
	};

	await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return okAgent(`reviewed ${i.id}`);
		},
		spawnDev: async (i) => {
			events.push(`dev ${i.id}`);
			return okAgent(`implemented ${i.id}`);
		},
	});

	// board-wide review list (no --parent filter)
	assert.deepEqual(script.calls[0], ["list", "--status", "review"]);
	// both pending items reviewed (deterministic order: position, then id)
	// before kb next runs
	assert.deepEqual(events.slice(0, 3), ["kb list --status review", "reviewer KB-4", "reviewer KB-9"]);
	assert.equal(events[3], "kb next");
	// then the retrieved element is worked
	assert.ok(events.includes("dev KB-13"));
});

test("bare invocation takes the first kb-next element regardless of story", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// element belongs to story KB-8, which is NOT first by position
	const nextItem = item("KB-13", "task", "todo", "KB-8");
	nextItem.position = 42;
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", () => kbRun(nextItem)],
			["show", () => kbRun(nextItem)],
		]),
	};

	let devId: string | null = null;
	await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async () => okAgent("reviewed"),
		spawnDev: async (i) => {
			devId = i.id;
			return okAgent("implemented");
		},
	});

	// kb next is called at board level: no --parent filter
	const nextCall = script.calls.find((c) => c[0] === "next");
	assert.deepEqual(nextCall, ["next"]);
	assert.equal(devId, "KB-13");
});

test("bare invocation completes one element then stops", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const nextItem = item("KB-13", "task", "review");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", () => kbRun(nextItem)],
			["show", () => kbRun(nextItem)],
		]),
	};

	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return okAgent("reviewed");
		},
		spawnDev: async (i) => {
			events.push(`dev ${i.id}`);
			return okAgent("implemented");
		},
	});

	// exactly one dev round and one reviewer round for the element
	assert.deepEqual(events, ["dev KB-13", "reviewer KB-13"]);
	// kb next is called exactly once: no loop over further elements
	assert.equal(script.calls.filter((c) => c[0] === "next").length, 1);
	// the report mentions the element and its final state
	assert.ok(result.report.includes("KB-13"));
	assert.ok(result.report.includes("review"));
});

test("bare invocation with nothing available notifies the user without side effects", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", () => kbRun({ error: "not found", message: "nothing available" }, 2)],
		]),
	};

	const notifications: Array<{ message: string; level: string }> = [];
	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		notify: (message, level) => notifications.push({ message, level }),
		spawnReviewer: async () => {
			events.push("reviewer");
			return okAgent("reviewed");
		},
		spawnDev: async () => {
			events.push("dev");
			return okAgent("implemented");
		},
	});

	assert.deepEqual(events, []); // no subagent ran
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "info");
	assert.ok(/nothing available/i.test(notifications[0].message));
	// no board mutation was attempted (no move/claim/checkout side effects via kb)
	assert.ok(script.calls.every((c) => c[0] === "list" || c[0] === "next"));
	assert.ok(/nothing available/i.test(result.report));
});

test("bare invocation retries a failed developer round once, then reviews on success", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const nextItem = item("KB-13", "task", "todo");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", () => kbRun(nextItem)],
			["show", () => kbRun(nextItem)],
		]),
	};

	let devCalls = 0;
	const events: string[] = [];
	await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return okAgent("reviewed");
		},
		spawnDev: async (i) => {
			devCalls++;
			events.push(`dev ${i.id} try ${devCalls}`);
			return devCalls === 1
				? { ok: false, output: "", stderr: "boom", errorMessage: "exit 1" }
				: okAgent("implemented");
		},
	});

	assert.equal(devCalls, 2);
	assert.deepEqual(events, ["dev KB-13 try 1", "dev KB-13 try 2", "reviewer KB-13"]);
});
