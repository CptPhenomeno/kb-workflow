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

const notFound = (): KbRun => kbRun({ error: "not found", message: "nothing available" }, 2);

/**
 * Script the FR-11 resolution chain: `next` handlers keyed by the query shape
 * (`--type epic`, `--type story [--parent X]`, plain `next`). Each slot is an
 * item (code 0) or "none" (code 2, nothing available at that level).
 */
function chainNext(script: {
	epic?: KbItem | "none";
	scopedStory?: KbItem | "none";
	story?: KbItem | "none";
	task?: KbItem | "none";
}): (args: string[]) => KbRun {
	return (args) => {
		const has = (flag: string) => args.includes(flag);
		if (has("epic")) return script.epic && script.epic !== "none" ? kbRun(script.epic) : notFound();
		if (has("story") && has("--parent"))
			return script.scopedStory && script.scopedStory !== "none" ? kbRun(script.scopedStory) : notFound();
		if (has("story")) return script.story && script.story !== "none" ? kbRun(script.story) : notFound();
		return script.task && script.task !== "none" ? kbRun(script.task) : notFound();
	};
}

/** The `next` handler for a bare task-level run: typed queries find nothing. */
function taskOnlyNext(task: KbItem): (args: string[]) => KbRun {
	return chainNext({ task });
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
					return taskOnlyNext(nextItem)(args);
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
	// the FR-11 chain starts with the epic query
	assert.equal(events[3], "kb next --type epic");
	// then the retrieved element is worked
	assert.ok(events.includes("dev KB-13"));
});

test("bare invocation takes the first story per kb next --type story", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// no epic available; the first story per kb next --type story is the unit
	const story = item("KB-8", "story", "doing", "KB-1");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", chainNext({ story })],
		]),
	};

	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async () => {
			events.push("reviewer");
			return okAgent("reviewed");
		},
		spawnDev: async () => {
			events.push("dev");
			return okAgent("implemented");
		},
	});

	// the story query drives the selection
	assert.ok(script.calls.some((c) => c.join(" ") === "next --type story"));
	// one unit per invocation: the story is the resolved unit
	assert.ok(result.report.includes("KB-8"));
	// the handler adds no own ordering and no task is picked directly
	assert.ok(!script.calls.some((c) => c.length === 1 && c[0] === "next"));
});

test("bare invocation completes one element then stops", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const nextItem = item("KB-13", "task", "review");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", taskOnlyNext(nextItem)],
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
	// the plain kb next (task/bug fallback) is called exactly once: no loop over further elements
	assert.equal(script.calls.filter((c) => c.length === 1 && c[0] === "next").length, 1);
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

test("sweep routes review items by type: tasks/subtasks to kb-reviewer, stories/epics to kb-qa", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const pending = [
		item("KB-9", "task", "review"),
		item("KB-10", "subtask", "review"),
		item("KB-8", "story", "review"),
		item("KB-1", "epic", "review"),
	];
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun(pending)],
			["next", () => kbRun({ error: "not found", message: "nothing available" }, 2)],
		]),
	};

	const events: string[] = [];
	await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return okAgent(`reviewed ${i.id}`);
		},
		spawnQa: async (i) => {
			events.push(`qa ${i.id}`);
			return okAgent(`qa ${i.id}`);
		},
		spawnDev: async () => {
			throw new Error("no dev round expected");
		},
	});

	// deterministic order (position, then id): reviewer for task/subtask, qa for story/epic
	assert.deepEqual(events, ["qa KB-1", "reviewer KB-10", "qa KB-8", "reviewer KB-9"]);
});

test("bare-mode story completion triggers the kb-qa story review", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// all tasks of story KB-8 are done: the story sits in review
	const taskItem = item("KB-13", "task", "done", "KB-8");
	const story = item("KB-8", "story", "review", "KB-1");
	const epic = item("KB-1", "epic", "doing", null);
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", taskOnlyNext(taskItem)],
			["show", (args) => {
				const id = args[1];
				if (id === "KB-13") return kbRun(taskItem);
				if (id === "KB-8") return kbRun(story);
				if (id === "KB-1") return kbRun(epic);
				return kbRun({ error: "not found" }, 2);
			}],
		]),
	};

	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return okAgent(`reviewed ${i.id}; merged feature/${i.id} into develop`);
		},
		spawnQa: async (i) => {
			events.push(`qa ${i.id}`);
			return okAgent(`qa ${i.id} OK — verified merged branches; deleted feature/KB-13`);
		},
		spawnDev: async (i) => {
			events.push(`dev ${i.id}`);
			return okAgent(`implemented ${i.id}`);
		},
	});

	// the story kb-qa round runs after the task's review round; the epic is
	// not in review (a sibling story is still open), so no epic round
	assert.deepEqual(events, ["dev KB-13", "reviewer KB-13", "qa KB-8"]);
	// the final report lists the qa round with its verdict and deletions
	assert.ok(result.report.includes("qa review KB-8"));
	assert.ok(result.report.includes("deleted feature/KB-13"));
});

test("all-stories-done triggers the epic kb-qa review", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const taskItem = item("KB-13", "task", "done", "KB-8");
	const story = item("KB-8", "story", "review", "KB-1");
	const epic = item("KB-1", "epic", "review", null);
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", taskOnlyNext(taskItem)],
			["show", (args) => {
				const id = args[1];
				if (id === "KB-13") return kbRun(taskItem);
				if (id === "KB-8") return kbRun(story);
				if (id === "KB-1") return kbRun(epic);
				return kbRun({ error: "not found" }, 2);
			}],
		]),
	};

	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return okAgent(`reviewed ${i.id}; merged feature/${i.id} into develop`);
		},
		spawnQa: async (i) => {
			events.push(`qa ${i.id}`);
			return okAgent(`qa ${i.id} OK — verified merged branches; deleted feature/KB-13`);
		},
		spawnDev: async (i) => {
			events.push(`dev ${i.id}`);
			return okAgent(`implemented ${i.id}`);
		},
	});

	// story round first, then the epic round (all sibling stories done)
	assert.deepEqual(events, ["dev KB-13", "reviewer KB-13", "qa KB-8", "qa KB-1"]);
	assert.ok(result.report.includes("qa review KB-8"));
	assert.ok(result.report.includes("qa review KB-1"));
	// the final report lists branches, merge outcomes, review verdicts and deletions
	assert.ok(result.report.includes("merged feature/KB-13 into develop"));
	assert.ok(result.report.includes("deleted feature/KB-13"));
});

test("no kb-qa round when the parent story is not in review", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const taskItem = item("KB-13", "task", "done", "KB-8");
	const story = item("KB-8", "story", "doing", "KB-1");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", taskOnlyNext(taskItem)],
			["show", (args) => (args[1] === "KB-13" ? kbRun(taskItem) : kbRun(story))],
		]),
	};

	const events: string[] = [];
	await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return okAgent(`reviewed ${i.id}`);
		},
		spawnQa: async (i) => {
			events.push(`qa ${i.id}`);
			return okAgent(`qa ${i.id}`);
		},
		spawnDev: async (i) => {
			events.push(`dev ${i.id}`);
			return okAgent(`implemented ${i.id}`);
		},
	});

	assert.deepEqual(events, ["dev KB-13", "reviewer KB-13"]);
});

test("bare invocation retries a failed developer round once, then reviews on success", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const nextItem = item("KB-13", "task", "todo");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", taskOnlyNext(nextItem)],
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

// --- KB-34: FR-11 resolution chain (epic → story → task) ---

test("available epic scopes the story resolved via kb next --type story --parent <epic>", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const epic = item("KB-1", "epic", "doing", null);
	const story = item("KB-8", "story", "doing", "KB-1");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", chainNext({ epic, scopedStory: story })],
		]),
	};

	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async () => {
			events.push("reviewer");
			return okAgent("reviewed");
		},
		spawnDev: async () => {
			events.push("dev");
			return okAgent("implemented");
		},
	});

	// chain order: epic query first, then the epic-scoped story query
	assert.deepEqual(script.calls.filter((c) => c[0] === "next"), [
		["next", "--type", "epic"],
		["next", "--type", "story", "--parent", "KB-1"],
		["next", "--parent", "KB-8"],
	]);
	// the scoped story is the resolved unit; no board-wide story query ran
	assert.ok(!script.calls.some((c) => c.join(" ") === "next --type story"));
	assert.ok(result.report.includes("KB-8"));
});

test("with no epic or empty scoped query, the story is resolved board-wide via kb next --type story", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// case A: no epic available at all
	const storyA = item("KB-8", "story", "doing", "KB-1");
	const scriptA: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", chainNext({ story: storyA })],
		]),
	};
	await runBareDev({
		cwd: dir,
		kb: fakeKb(scriptA),
		spawnReviewer: async () => okAgent("reviewed"),
		spawnDev: async () => okAgent("implemented"),
	});
	assert.ok(scriptA.calls.some((c) => c.join(" ") === "next --type story"));

	// case B: an epic is available but the scoped query returns nothing
	// (e.g. the story was reopened under a done epic)
	const epic = item("KB-2", "epic", "doing", null);
	const storyB = item("KB-9", "story", "todo", "KB-2");
	const scriptB: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", chainNext({ epic, scopedStory: "none", story: storyB })],
		]),
	};
	const resultB = await runBareDev({
		cwd: dir,
		kb: fakeKb(scriptB),
		spawnReviewer: async () => okAgent("reviewed"),
		spawnDev: async () => okAgent("implemented"),
	});
	assert.deepEqual(scriptB.calls.filter((c) => c[0] === "next"), [
		["next", "--type", "epic"],
		["next", "--type", "story", "--parent", "KB-2"],
		["next", "--type", "story"],
		["next", "--parent", "KB-9"],
	]);
	assert.ok(resultB.report.includes("KB-9"));
});

test("with no story available, a single task or bug is resolved via kb next", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// a task reopened under a done story: no story available, task fallback
	const taskItem = item("KB-13", "task", "todo", "KB-8");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", chainNext({ task: taskItem })],
			["show", () => kbRun(taskItem)],
		]),
	};

	const events: string[] = [];
	await runBareDev({
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

	// the full chain ran in order and the plain kb next resolved the unit
	assert.deepEqual(script.calls.filter((c) => c[0] === "next"), [
		["next", "--type", "epic"],
		["next", "--type", "story"],
		["next"],
	]);
	assert.deepEqual(events, ["dev KB-13", "reviewer KB-13"]);
});

test("nothing available at any level notifies the user without side effects", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", chainNext({})],
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
	// the whole chain was queried before giving up
	assert.deepEqual(script.calls.filter((c) => c[0] === "next"), [
		["next", "--type", "epic"],
		["next", "--type", "story"],
		["next"],
	]);
	// no board mutation and no task/branch side effects via kb
	assert.ok(script.calls.every((c) => c[0] === "list" || c[0] === "next"));
	assert.ok(/nothing available/i.test(result.report));
});

// --- KB-35: FR-11 story loop (whole story per invocation) ---

/**
 * Script the story loop: `next --parent <story>` pops tasks from a queue
 * (exit 2 when empty); typed queries resolve the story board-wide. The
 * story's `show` status flips to `review` once the task queue is empty
 * (all tasks done), the epic's when `epicReview` is set.
 */
function storyLoopScript(opts: {
	story: KbItem;
	epic: KbItem;
	tasks: KbItem[];
	/** The story flips to `review` when the task queue empties. */
	storyReview?: boolean;
	epicReview?: boolean;
}) {
	const queue = [...opts.tasks];
	const showStory = (id: string): KbRun => {
		if (id === opts.story.id) {
			const status = !queue.length && opts.storyReview ? "review" : opts.story.status;
			return kbRun({ ...opts.story, status });
		}
		if (id === opts.epic.id) {
			return kbRun({ ...opts.epic, status: opts.epicReview ? "review" : opts.epic.status });
		}
		const task = opts.tasks.find((t) => t.id === id);
		return task ? kbRun({ ...task, status: "done" }) : kbRun({ error: "not found" }, 2);
	};
	return {
		calls: [] as string[][],
		responses: new Map<string, (args: string[]) => KbRun>([
			["list", () => kbRun([])],
			[
				"next",
				(args) => {
					if (args.includes("--parent")) {
						const next = queue.shift();
						return next ? kbRun(next) : notFound();
					}
					return chainNext({ story: opts.story })(args);
				},
			],
			["show", (args) => showStory(args[1])],
		]),
	};
}

function storyLoopDeps(dir: string, script: ScriptedKb, events: string[]) {
	return {
		cwd: dir,
		kb: fakeKb(script),
		spawnDev: async (i: KbItem) => {
			events.push(`dev ${i.id}`);
			return okAgent(`implemented ${i.id}`);
		},
		spawnReviewer: async (i: KbItem) => {
			events.push(`reviewer ${i.id}`);
			return okAgent(`reviewed ${i.id}; merged feature/${i.id} into develop`);
		},
		spawnQa: async (i: KbItem) => {
			events.push(`qa ${i.id}`);
			return okAgent(`qa ${i.id} OK — verified merged branches; deleted feature/KB-13 feature/KB-14`);
		},
	} as const;
}

test("each story task runs the full branch/develop/review/merge cycle in DAG order", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const story = item("KB-8", "story", "doing", "KB-1");
	const epic = item("KB-1", "epic", "doing", null);
	const t1 = item("KB-13", "task", "todo", "KB-8");
	const t2 = item("KB-14", "task", "todo", "KB-8");
	const script = storyLoopScript({ story, epic, tasks: [t1, t2] });

	const events: string[] = [];
	const result = await runBareDev(storyLoopDeps(dir, script, events));

	// both tasks of the story are worked in DAG order, each through its
	// full dev → review cycle
	assert.deepEqual(events, ["dev KB-13", "reviewer KB-13", "dev KB-14", "reviewer KB-14"]);
	// the task loop is driven by kb next --parent <story> until exit 2
	const parentCalls = script.calls.filter((c) => c.includes("--parent"));
	assert.equal(parentCalls.length, 3);
	assert.ok(parentCalls.every((c) => c.join(" ") === "next --parent KB-8"));
	// the report lists every task worked with its branch and merge outcome (NFR-4)
	assert.ok(result.report.includes("branch feature/KB-13"));
	assert.ok(result.report.includes("branch feature/KB-14"));
	assert.ok(result.report.includes("merged feature/KB-13 into develop"));
	assert.ok(result.report.includes("merged feature/KB-14 into develop"));
});

test("story reaching review after all tasks spawns the kb-qa story review", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const story = item("KB-8", "story", "doing", "KB-1");
	const epic = item("KB-1", "epic", "doing", null);
	const t1 = item("KB-13", "task", "todo", "KB-8");
	const t2 = item("KB-14", "task", "todo", "KB-8");
	const script = storyLoopScript({ story, epic, tasks: [t1, t2], storyReview: true });

	const events: string[] = [];
	const result = await runBareDev(storyLoopDeps(dir, script, events));

	// after the last task's review the story sits in review: the kb-qa
	// story round fires within the story loop; the epic is still doing,
	// so no epic round
	assert.deepEqual(events, [
		"dev KB-13",
		"reviewer KB-13",
		"dev KB-14",
		"reviewer KB-14",
		"qa KB-8",
	]);
	assert.ok(result.report.includes("qa review KB-8"));
	assert.ok(!result.report.includes("qa review KB-1"));
});

test("epic reaching review after all sibling stories spawns the kb-qa epic review", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const story = item("KB-8", "story", "doing", "KB-1");
	const epic = item("KB-1", "epic", "doing", null);
	const t1 = item("KB-13", "task", "todo", "KB-8");
	const t2 = item("KB-14", "task", "todo", "KB-8");
	const script = storyLoopScript({ story, epic, tasks: [t1, t2], storyReview: true, epicReview: true });

	const events: string[] = [];
	const result = await runBareDev(storyLoopDeps(dir, script, events));

	// story round first, then the epic round (all sibling stories done)
	assert.deepEqual(events, [
		"dev KB-13",
		"reviewer KB-13",
		"dev KB-14",
		"reviewer KB-14",
		"qa KB-8",
		"qa KB-1",
	]);
	assert.ok(result.report.includes("qa review KB-8"));
	assert.ok(result.report.includes("qa review KB-1"));
});

test("invocation stops after the story and any epic review", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const story = item("KB-8", "story", "doing", "KB-1");
	const epic = item("KB-1", "epic", "doing", null);
	const t1 = item("KB-13", "task", "todo", "KB-8");
	const t2 = item("KB-14", "task", "todo", "KB-8");
	const script = storyLoopScript({ story, epic, tasks: [t1, t2], storyReview: true, epicReview: true });

	const events: string[] = [];
	await runBareDev(storyLoopDeps(dir, script, events));

	// one story per invocation: after the story (and epic) qa rounds no
	// further unit is resolved — the only board-level next queries are the
	// FR-11 chain queries that resolved the story
	const boardNext = script.calls.filter((c) => c[0] === "next" && !c.includes("--parent"));
	assert.deepEqual(boardNext, [["next", "--type", "epic"], ["next", "--type", "story"]]);
	// the invocation ends with the epic qa round
	assert.equal(events[events.length - 1], "qa KB-1");
});

// --- KB-36: remaining AC-21 coverage (sweep × story loop, report, edge cases) ---

test("FR-12 sweep completes pending reviews before the story loop; report covers the full story run", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// a task and a story already sit in review: the sweep completes them
	// (routed by type) before the FR-11 chain resolves the story to work
	const pendingTask = item("KB-9", "task", "review", "KB-7");
	const pendingStory = item("KB-7", "story", "review", "KB-1");
	const epic = item("KB-1", "epic", "doing", null);
	const story = item("KB-8", "story", "doing", "KB-1");
	const t1 = item("KB-13", "task", "todo", "KB-8");
	const t2 = item("KB-14", "task", "todo", "KB-8");
	const queue = [t1, t2];
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([pendingStory, pendingTask])],
			[
				"next",
				(args) => {
					if (args.includes("--parent") && !args.includes("--type")) {
						const next = queue.shift();
						return next ? kbRun(next) : notFound();
					}
					return chainNext({ epic, scopedStory: story })(args);
				},
			],
			[
				"show",
				(args) => {
					const id = args[1];
					if (id === story.id) return kbRun({ ...story, status: queue.length ? "doing" : "review" });
					if (id === epic.id) return kbRun(epic);
					const task = [t1, t2].find((x) => x.id === id);
					return task ? kbRun({ ...task, status: "done" }) : kbRun({ error: "not found" }, 2);
				},
			],
		]),
	};

	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return okAgent(`reviewed ${i.id}; merged feature/${i.id} into develop`);
		},
		spawnQa: async (i) => {
			events.push(`qa ${i.id}`);
			return okAgent(`qa ${i.id} OK — verified merged branches; deleted feature/KB-9`);
		},
		spawnDev: async (i) => {
			events.push(`dev ${i.id}`);
			return okAgent(`implemented ${i.id}`);
		},
	});

	// the sweep completes both pending reviews first — the pending story
	// routed to kb-qa, the pending task to kb-reviewer — then the story
	// loop works the resolved story's tasks in DAG order, and the qa round
	// for the freshly finished story fires at the end
	assert.deepEqual(events, [
		"qa KB-7",
		"reviewer KB-9",
		"dev KB-13",
		"reviewer KB-13",
		"dev KB-14",
		"reviewer KB-14",
		"qa KB-8",
	]);
	// one story per invocation: only the sweep + the FR-11 chain + the
	// story's own --parent queries ran
	const boardNext = script.calls.filter((c) => c[0] === "next" && c[1] !== "--parent");
	assert.deepEqual(boardNext, [
		["next", "--type", "epic"],
		["next", "--type", "story", "--parent", "KB-1"],
	]);
	// the report covers the whole run: the swept items, the resolved unit
	// with its provenance, every task cycle, and the final story state
	assert.ok(result.report.includes("qa review KB-7"));
	assert.ok(result.report.includes("review KB-9"));
	assert.ok(result.report.includes('resolved unit: story KB-8 "item KB-8" (epic KB-1-scoped story); one story per invocation.'));
	assert.ok(result.report.includes("branch feature/KB-13"));
	assert.ok(result.report.includes("merged feature/KB-13 into develop"));
	assert.ok(result.report.includes("merged feature/KB-14 into develop"));
	assert.ok(result.report.includes("story KB-8: 2 task(s) worked."));
	assert.ok(result.report.includes('Story KB-8 is now in column "review".'));
});

test("reviewer failure mid-story stops the story loop before the next task", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const story = item("KB-8", "story", "doing", "KB-1");
	const epic = item("KB-1", "epic", "doing", null);
	const t1 = item("KB-13", "task", "todo", "KB-8");
	const t2 = item("KB-14", "task", "todo", "KB-8");
	const queue = [t1, t2];
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			[
				"next",
				(args) => {
					if (args.includes("--parent")) {
						const next = queue.shift();
						return next ? kbRun(next) : notFound();
					}
					return chainNext({ story })(args);
				},
			],
			[
				"show",
				(args) => {
					const id = args[1];
					if (id === story.id) return kbRun(story);
					if (id === epic.id) return kbRun(epic);
					const task = [t1, t2].find((x) => x.id === id);
					return task ? kbRun(task) : kbRun({ error: "not found" }, 2);
				},
			],
		]),
	};

	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => {
			events.push(`reviewer ${i.id}`);
			return i.id === "KB-13"
				? { ok: false, output: "", stderr: "merge conflict", errorMessage: "exit 1" }
				: okAgent(`reviewed ${i.id}`);
		},
		spawnQa: async (i) => {
			events.push(`qa ${i.id}`);
			return okAgent(`qa ${i.id}`);
		},
		spawnDev: async (i) => {
			events.push(`dev ${i.id}`);
			return okAgent(`implemented ${i.id}`);
		},
	});

	// the first task's review failed: its cycle did not complete, so the
	// loop stops — the second task is never worked and no qa round fires
	assert.deepEqual(events, ["dev KB-13", "reviewer KB-13"]);
	// the loop broke right after the failed cycle: only the initial
	// --parent query ran
	assert.equal(script.calls.filter((c) => c.join(" ") === "next --parent KB-8").length, 1);
	// the report shows the failed review
	assert.ok(result.report.includes("review KB-13"));
	assert.ok(result.report.includes("FAILED"));
	assert.ok(result.report.includes("story KB-8: 0 task(s) worked."));
	// the story never reached review: no qa round in the report
	assert.ok(!result.report.includes("qa review"));
});

test("empty story reports zero tasks worked and its final column", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const story = item("KB-8", "story", "doing", "KB-1");
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", chainNext({ story })],
			["show", () => kbRun({ ...story, status: "todo" })],
		]),
	};

	const events: string[] = [];
	const result = await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		spawnReviewer: async (i) => okAgent(`reviewed ${i.id}`),
		spawnQa: async (i) => okAgent(`qa ${i.id}`),
		spawnDev: async (i) => {
			events.push(`dev ${i.id}`);
			return okAgent(`implemented ${i.id}`);
		},
	});

	// no task is available under the story: nothing is worked
	assert.deepEqual(events, []);
	assert.ok(script.calls.some((c) => c.join(" ") === "next --parent KB-8"));
	assert.ok(result.report.includes("story KB-8: 0 task(s) worked."));
	assert.ok(result.report.includes('Story KB-8 is now in column "todo".'));
});

test("bare invocation with no story available notifies the user without side effects", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// no story and no task/bug either: nothing to work at any level
	const script: ScriptedKb = {
		calls: [],
		responses: new Map([
			["list", () => kbRun([])],
			["next", chainNext({})],
		]),
	};

	const notifications: Array<{ message: string; level: string }> = [];
	await runBareDev({
		cwd: dir,
		kb: fakeKb(script),
		notify: (message, level) => notifications.push({ message, level }),
		spawnReviewer: async () => okAgent("reviewed"),
		spawnDev: async () => okAgent("implemented"),
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "info");
	assert.ok(/nothing available/i.test(notifications[0].message));
});

// ---------------------------------------------------------------------------
// KB-8: per-role model and thinking-level resolution in the dispatchers.
// ---------------------------------------------------------------------------

test("bare-mode round resolves and forwards model and thinking-level per role", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const task = item("KB-42", "task", "todo", null);
	const seen: Array<{ role: string; model?: string; thinkingLevel?: string }> = [];

	await runBareDev({
		cwd: dir,
		kb: fakeKb({
			calls: [],
			responses: new Map([
				["list", () => kbRun([])],
				["next", () => kbRun(task)],
				["show", (args) => kbRun(args.includes("KB-42") ? task : notFound())],
			]),
		}),
		config: {
			kbAgents: {
				developer: { model: "provider/dev", thinkingLevel: "high" },
				reviewer: { thinkingLevel: "low" }, // model unset -> session model
			},
		},
		session: { model: "provider/session", thinkingLevel: "medium" },
		spawnDev: async (_i, resolved) => {
			seen.push({ role: "developer", ...resolved });
			return okAgent("dev ok");
		},
		spawnReviewer: async (_i, resolved) => {
			seen.push({ role: "reviewer", ...resolved });
			return okAgent("review ok");
		},
	});

	assert.deepEqual(seen, [
		{ role: "developer", model: "provider/dev", thinkingLevel: "high" },
		{ role: "reviewer", model: "provider/session", thinkingLevel: "low" },
	]);
});

test("qa role round forwards its configured model and thinking-level", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const story = item("KB-1", "story", "review");
	const seen: Array<{ model?: string; thinkingLevel?: string }> = [];

	await runBareDev({
		cwd: dir,
		kb: fakeKb({
			calls: [],
			responses: new Map([
				["list", () => kbRun([story])],
				["next", () => notFound()],
			]),
		}),
		config: {
			kbAgents: { qa: { model: "provider/qa", thinkingLevel: "xhigh" } },
		},
		session: { model: "provider/session", thinkingLevel: "medium" },
		spawnQa: async (_i, resolved) => {
			seen.push({ ...resolved });
			return okAgent("qa ok");
		},
	});

	assert.deepEqual(seen, [{ model: "provider/qa", thinkingLevel: "xhigh" }]);
});
