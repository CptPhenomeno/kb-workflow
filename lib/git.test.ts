import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

import {
	isWorkingTreeClean,
	preFlightCheck,
	checkout,
	branchNameFor,
	branchExists,
	ensureTaskBranch,
} from "./git.ts";

function tmpRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-git-test-"));
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

test("dirty tree detection via git status --porcelain", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	assert.equal(await isWorkingTreeClean(dir), true);
	fs.writeFileSync(path.join(dir, "b.txt"), "b");
	assert.equal(await isWorkingTreeClean(dir), false);
	// staged changes are also dirty
	execSync("git add b.txt", { cwd: dir });
	assert.equal(await isWorkingTreeClean(dir), false);
});

test("branch prefix feature/ for tasks and fix/ for bugs", (t) => {
	t.assert.equal(branchNameFor("task", "KB-13"), "feature/KB-13");
	t.assert.equal(branchNameFor("bug", "KB-42"), "fix/KB-42");
	// anything that is not a bug gets feature/
	t.assert.equal(branchNameFor("subtask", "KB-7"), "feature/KB-7");
});

test("checkout switches branches and fails on error", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	await checkout(dir, "develop");
	t.assert.equal(git("rev-parse --abbrev-ref HEAD", dir).trim(), "develop");

	await assert.rejects(() => checkout(dir, "no-such-branch"));
});

test("existing branch is reused, never recreated", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// create the branch with a commit ahead of develop
	execSync("git checkout -b feature/KB-13", { cwd: dir });
	fs.writeFileSync(path.join(dir, "c.txt"), "c");
	execSync("git add . && git commit -m work", { cwd: dir });
	const tip = git("rev-parse feature/KB-13", dir).trim();
	execSync("git checkout develop", { cwd: dir });

	t.assert.equal(await branchExists(dir, "feature/KB-13"), true);
	t.assert.equal(await branchExists(dir, "feature/KB-99"), false);

	// reuse: checked out, tip unchanged, still based on same commit
	const reused = await ensureTaskBranch(dir, "task", "KB-13");
	t.assert.equal(reused, "feature/KB-13");
	t.assert.equal(git("rev-parse --abbrev-ref HEAD", dir).trim(), "feature/KB-13");
	t.assert.equal(git("rev-parse feature/KB-13", dir).trim(), tip);

	// creation path: fresh branch from develop
	const created = await ensureTaskBranch(dir, "bug", "KB-99");
	t.assert.equal(created, "fix/KB-99");
	t.assert.equal(git("rev-parse --abbrev-ref HEAD", dir).trim(), "fix/KB-99");
	t.assert.equal(
		git("rev-parse fix/KB-99", dir).trim(),
		git("rev-parse develop", dir).trim(),
	);
});

// --- KB-14: merge chain, ancestry check, safe branch deletion ---

import { mergeChain, isMerged, deleteMergedBranch } from "./git.ts";

function commit(dir: string, file: string, content: string, msg: string): void {
	fs.writeFileSync(path.join(dir, file), content);
	execSync(`git add ${file} && git commit -m ${JSON.stringify(msg)}`, { cwd: dir });
}

test("ff merge succeeds when develop is behind", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	execSync("git checkout -b feature/KB-14", { cwd: dir });
	commit(dir, "f.txt", "f", "work");
	const tip = git("rev-parse feature/KB-14", dir).trim();
	execSync("git checkout develop", { cwd: dir });
	const before = git("rev-parse develop", dir).trim();

	const outcome = await mergeChain(dir, "feature/KB-14", "KB-14");
	t.assert.equal(outcome, "ff");
	// develop fast-forwarded to the branch tip
	t.assert.equal(git("rev-parse develop", dir).trim(), tip);
	t.assert.notEqual(git("rev-parse develop", dir).trim(), before);
});

test("no-ff merge used when ff fails", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// develop moves forward, branch diverges -> ff impossible
	execSync("git checkout -b feature/KB-14", { cwd: dir });
	commit(dir, "f.txt", "f", "work");
	execSync("git checkout develop", { cwd: dir });
	commit(dir, "g.txt", "g", "develop work");

	const outcome = await mergeChain(dir, "feature/KB-14", "KB-14");
	t.assert.equal(outcome, "no-ff");
	// merge commit message references the task ID
	const log = git("log -1 --format=%B develop", dir);
	t.assert.ok(log.includes("KB-14"));
	// both changes reachable from develop
	t.assert.ok(fs.existsSync(path.join(dir, "f.txt")));
	t.assert.ok(fs.existsSync(path.join(dir, "g.txt")));
});

test("conflicting merge aborts and develop is unchanged", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	execSync("git checkout -b feature/KB-14", { cwd: dir });
	commit(dir, "a.txt", "branch", "branch change");
	execSync("git checkout develop", { cwd: dir });
	commit(dir, "a.txt", "develop", "develop change");
	const before = git("rev-parse develop", dir).trim();

	const outcome = await mergeChain(dir, "feature/KB-14", "KB-14");
	t.assert.equal(outcome, "failed");
	t.assert.equal(git("rev-parse develop", dir).trim(), before);
	// tree clean, no merge in progress
	t.assert.equal(git("status --porcelain", dir).trim(), "");
});

test("isMerged reports ancestry of develop correctly", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	execSync("git checkout -b feature/KB-14", { cwd: dir });
	commit(dir, "f.txt", "f", "work");
	execSync("git checkout develop", { cwd: dir });
	t.assert.equal(await isMerged(dir, "feature/KB-14"), false);

	commit(dir, "g.txt", "g", "develop work");
	execSync("git merge --no-ff feature/KB-14 -m m", { cwd: dir });
	t.assert.equal(await isMerged(dir, "feature/KB-14"), true);
});

test("deletion uses -d and refuses unmerged branches", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	execSync("git checkout -b feature/KB-14", { cwd: dir });
	commit(dir, "f.txt", "f", "work");
	execSync("git checkout develop", { cwd: dir });
	// unmerged: deletion refuses, branch survives
	await t.assert.rejects(() => deleteMergedBranch(dir, "feature/KB-14"));
	t.assert.equal(await branchExists(dir, "feature/KB-14"), true);

	execSync("git merge --ff-only feature/KB-14", { cwd: dir });
	await deleteMergedBranch(dir, "feature/KB-14");
	t.assert.equal(await branchExists(dir, "feature/KB-14"), false);
});

// --- KB-25: all-branches-merged verification gates deletion (FR-13 step 2, FR-7) ---

import { verifyAndDeleteTaskBranches } from "./git.ts";

test("all-branches-merged verification gates deletion", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// story with two task branches: one merged into develop, one not
	execSync("git checkout -b feature/KB-21", { cwd: dir });
	commit(dir, "f.txt", "f", "merged work");
	execSync("git checkout develop", { cwd: dir });
	execSync("git merge --ff-only feature/KB-21", { cwd: dir });

	execSync("git checkout -b fix/KB-22", { cwd: dir });
	commit(dir, "u.txt", "u", "unmerged work");
	execSync("git checkout develop", { cwd: dir });

	// one branch is not an ancestor of develop: nothing is deleted,
	// the unmerged branch is reported as a problem
	const refused = await verifyAndDeleteTaskBranches(dir, [
		"feature/KB-21",
		"fix/KB-22",
	]);
	t.assert.equal(refused.ok, false);
	t.assert.deepEqual(refused.problems, ["fix/KB-22"]);
	t.assert.deepEqual(refused.deleted, []);
	t.assert.equal(await branchExists(dir, "feature/KB-21"), true);
	t.assert.equal(await branchExists(dir, "fix/KB-22"), true);

	// merge the second branch too: now all tips are ancestors of
	// develop and every branch is deleted with `git branch -d`
	execSync("git merge --ff-only fix/KB-22", { cwd: dir });
	const ok = await verifyAndDeleteTaskBranches(dir, [
		"feature/KB-21",
		"fix/KB-22",
	]);
	t.assert.equal(ok.ok, true);
	t.assert.deepEqual(ok.problems, []);
	t.assert.deepEqual(ok.deleted, ["feature/KB-21", "fix/KB-22"]);
	t.assert.equal(await branchExists(dir, "feature/KB-21"), false);
	t.assert.equal(await branchExists(dir, "fix/KB-22"), false);
});

test("missing task branches are skipped, not treated as problems", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	execSync("git checkout -b feature/KB-21", { cwd: dir });
	commit(dir, "f.txt", "f", "work");
	execSync("git checkout develop", { cwd: dir });
	execSync("git merge --ff-only feature/KB-21", { cwd: dir });

	// a branch deleted by an earlier round simply no longer exists
	const res = await verifyAndDeleteTaskBranches(dir, [
		"feature/KB-21",
		"feature/KB-99",
	]);
	t.assert.equal(res.ok, true);
	t.assert.deepEqual(res.problems, []);
	t.assert.deepEqual(res.deleted, ["feature/KB-21"]);
});

test("dirty tree aborts the run before any kb or git mutation", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// start on a side branch with an uncommitted change
	execSync("git checkout -b feature/KB-16", { cwd: dir });
	fs.writeFileSync(path.join(dir, "dirty.txt"), "dirty");
	const headBefore = git("rev-parse HEAD", dir).trim();

	const res = await preFlightCheck(dir);
	t.assert.equal(res.ok, false);
	t.assert.match(res.error, /commit or stash/i);

	// no git mutation: same commit checked out, change still untracked
	t.assert.equal(git("rev-parse HEAD", dir).trim(), headBefore);
	t.assert.equal(git("rev-parse --abbrev-ref HEAD", dir).trim(), "feature/KB-16");
	t.assert.equal(fs.existsSync(path.join(dir, "dirty.txt")), true);
	// no stash was created (no automatic stash / auto-commit)
	t.assert.equal(git("stash list", dir).trim(), "");
});

test("clean tree proceeds and checks out develop first", async (t) => {
	const dir = tmpRepo();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// clean tree but on another branch
	execSync("git checkout -b feature/KB-17", { cwd: dir });
	const res = await preFlightCheck(dir);
	t.assert.equal(res.ok, true);
	t.assert.equal(git("rev-parse --abbrev-ref HEAD", dir).trim(), "develop");
});
