import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

import { runDeveloperRound } from "./orchestration.ts";
import type { KbItem } from "./kb.ts";

function tmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-orch-test-"));
	execSync("git init -b develop", { cwd: dir });
	execSync("git config user.email t@t", { cwd: dir });
	execSync("git config user.name t", { cwd: dir });
	fs.writeFileSync(path.join(dir, "a.txt"), "a");
	execSync("git add . && git commit -m init", { cwd: dir });
	return dir;
}

function git(args: string, cwd: string): string {
	return execSync(`git ${args}`, { cwd }).toString();
}

function item(id: string, type: KbItem["type"]): KbItem {
	return {
		id,
		ref: null,
		type,
		title: `item ${id}`,
		description: "",
		parent: "KB-1",
		status: "todo",
		priority: "medium",
		points: null,
		spec: null,
		labels: [],
		links: [],
		acceptance: [],
		tests: [],
		tdd_phase: null,
	} as KbItem;
}

test("handler checks out the task branch before spawning developer", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// advance develop so the branch base is observable
	fs.writeFileSync(path.join(dir, "dev.txt"), "dev");
	execSync("git add . && git commit -m dev-work", { cwd: dir });
	const developTip = git("rev-parse develop", dir).trim();

	const seenBranches: string[] = [];
	const round = await runDeveloperRound({
		cwd: dir,
		task: item("KB-13", "task"),
		spawnDev: async () => {
			// the developer subagent must find the task branch active
			seenBranches.push(git("rev-parse --abbrev-ref HEAD", dir).trim());
			return { ok: true };
		},
	});

	t.assert.equal(round.branch, "feature/KB-13");
	t.assert.deepEqual(seenBranches, ["feature/KB-13"]);
	// created from develop
	t.assert.equal(git("rev-parse feature/KB-13", dir).trim(), developTip);

	// a bug gets the fix/ prefix
	const bugRound = await runDeveloperRound({
		cwd: dir,
		task: item("KB-42", "bug"),
		spawnDev: async () => {
			seenBranches.push(git("rev-parse --abbrev-ref HEAD", dir).trim());
			return { ok: true };
		},
	});
	t.assert.equal(bugRound.branch, "fix/KB-42");
	t.assert.deepEqual(seenBranches, ["feature/KB-13", "fix/KB-42"]);
});

test("review-to-todo round reuses the same branch", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const spawn = async () => {
		const head = git("rev-parse --abbrev-ref HEAD", dir).trim();
		return { ok: true, head };
	};

	// round 1: branch created, developer commits on it
	const round1 = await runDeveloperRound({ cwd: dir, task: item("KB-13", "task"), spawnDev: spawn });
	fs.writeFileSync(path.join(dir, "work.txt"), "work");
	execSync("git add . && git commit -m task-work", { cwd: dir });
	const tip = git("rev-parse feature/KB-13", dir).trim();

	// review sends the task back to todo: developer is elsewhere (develop checked out)
	execSync("git checkout develop", { cwd: dir });

	// round 2: same branch reused, tip preserved, no recreation
	const round2 = await runDeveloperRound({ cwd: dir, task: item("KB-13", "task"), spawnDev: spawn });
	t.assert.equal(round2.branch, round1.branch);
	t.assert.equal(git("rev-parse --abbrev-ref HEAD", dir).trim(), "feature/KB-13");
	t.assert.equal(git("rev-parse feature/KB-13", dir).trim(), tip);
	t.assert.equal(round2.result?.head, "feature/KB-13");
});
