/**
 * Local git plumbing for the /kb-dev handler (SPEC v0.1.0, FR-1/FR-2).
 *
 * All operations are local only (NFR-1): no push, pull, fetch or any
 * remote interaction. Every git command's exit code is checked and
 * failures reject with a descriptive error (NFR-3). Existing task
 * branches are never deleted or recreated (NFR-2).
 */

import { spawn } from "node:child_process";

export type KbItemType = "epic" | "story" | "task" | "subtask" | "bug";

export interface GitRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Run a local git command; never throws, returns exit code and output. */
export function runGit(args: string[], cwd: string): Promise<GitRun> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (err) => resolve({ code: null, stdout, stderr: `${stderr}${err}` }));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/** Run a local git command, rejecting on a non-zero exit code (NFR-3). */
export async function runGitChecked(args: string[], cwd: string): Promise<string> {
	const res = await runGit(args, cwd);
	if (res.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${res.code}): ${res.stderr.trim()}`);
	}
	return res.stdout;
}

/** True when the working tree has no changes (FR-1: `git status --porcelain` is empty). */
export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
	const out = await runGitChecked(["status", "--porcelain"], cwd);
	return out.trim().length === 0;
}

/**
 * Result of the /kb-dev pre-flight check (FR-1).
 */
export type PreFlightResult =
	| { ok: true }
	| { ok: false; error: string };

/**
 * Pre-flight check for the /kb-dev handler (FR-1, AC-1).
 *
 * Runs `git status --porcelain`: on a dirty tree it returns an error asking
 * the user to commit or stash manually — no automatic stash, no auto-commit,
 * no git mutation at all. On a clean tree it checks out `develop` (before the
 * first task of the run) and returns ok.
 */
export async function preFlightCheck(cwd: string): Promise<PreFlightResult> {
	if (!(await isWorkingTreeClean(cwd))) {
		return {
			ok: false,
			error:
				"The working tree is dirty. Please commit or stash your changes manually, then run /kb-dev again. " +
				"(No automatic stash or commit is performed.)",
		};
	}
	await checkout(cwd, "develop");
	return { ok: true };
}

/** Checkout a branch (local only); rejects when the branch does not exist. */
export async function checkout(cwd: string, branch: string): Promise<void> {
	await runGitChecked(["checkout", branch], cwd);
}

/** Branch name for a kb item: `fix/<id>` for bugs, `feature/<id>` otherwise (FR-2). */
export function branchNameFor(type: KbItemType, id: string): string {
	return type === "bug" ? `fix/${id}` : `feature/${id}`;
}

/** True when a local branch exists. */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const res = await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd);
	return res.code === 0;
}

/**
 * Create or reuse the task branch for a kb item and check it out (FR-2).
 *
 * The branch is created from `develop` when it does not exist; when it
 * already exists (e.g. a review round sent the task back to todo) it is
 * reused as is — never deleted or recreated (NFR-2). Returns the branch
 * name, which is left checked out.
 */
export async function ensureTaskBranch(
	cwd: string,
	type: KbItemType,
	id: string,
): Promise<string> {
	const branch = branchNameFor(type, id);
	if (await branchExists(cwd, branch)) {
		await checkout(cwd, branch);
		return branch;
	}
	await checkout(cwd, "develop");
	await runGitChecked(["checkout", "-b", branch], cwd);
	return branch;
}

/**
 * --- KB-14: merge chain (FR-4), ancestry check and safe deletion (FR-7) ---
 */

export type MergeOutcome = "ff" | "no-ff" | "failed";

/**
 * Try merging `branch` into `develop` (which must be checked out first by
 * the caller): `--ff-only`, then `--no-ff` with a message referencing the
 * task ID, and on failure `git merge --abort` leaving develop unchanged
 * (FR-4, AC-5). Returns the outcome.
 */
export async function mergeChain(
	cwd: string,
	branch: string,
	taskId: string,
): Promise<MergeOutcome> {
	await checkout(cwd, "develop");
	const ff = await runGit(["merge", "--ff-only", branch], cwd);
	if (ff.code === 0) return "ff";
	const noff = await runGit(
		["merge", "--no-ff", branch, "-m", `Merge ${branch} (task ${taskId}) into develop`],
		cwd,
	);
	if (noff.code === 0) return "no-ff";
	// leave develop unchanged: abort any in-progress merge (AC-5)
	await runGitChecked(["merge", "--abort"], cwd);
	return "failed";
}

/**
 * True when the branch tip is an ancestor of `develop` (FR-7): the branch's
 * changes are reachable from develop and it is safe to delete it.
 */
export async function isMerged(cwd: string, branch: string): Promise<boolean> {
	const res = await runGit(
		["merge-base", "--is-ancestor", branch, "develop"],
		cwd,
	);
	return res.code === 0;
}

/**
 * Delete a task branch with the safe `git branch -d`, which refuses
 * branches not merged into develop (FR-7, NFR-2: never `-D`).
 */
export async function deleteMergedBranch(cwd: string, branch: string): Promise<void> {
	await runGitChecked(["branch", "-d", branch], cwd);
}

export interface BranchCleanupResult {
	/** False when any existing branch is not merged into develop. */
	ok: boolean;
	/** Branches deleted with `git branch -d` (empty when ok is false). */
	deleted: string[];
	/** Existing branches whose tip is not an ancestor of develop. */
	problems: string[];
}

/**
 * kb-qa branch cleanup (SPEC v0.1.2, FR-13 step 2, FR-7): verify that the
 * tip of every existing task branch is an ancestor of `develop` before
 * deleting anything. When all branches are merged, delete each with the
 * safe `git branch -d`. When any branch is not merged, delete nothing and
 * report the unmerged branches as problems — the caller treats that as a
 * failed qa review. Branches that do not exist (e.g. deleted by an earlier
 * round) are skipped. Local only, never `-D` (NFR-1, NFR-2).
 */
export async function verifyAndDeleteTaskBranches(
	cwd: string,
	branches: string[],
): Promise<BranchCleanupResult> {
	const existing: string[] = [];
	const problems: string[] = [];
	for (const branch of branches) {
		if (!(await branchExists(cwd, branch))) continue;
		existing.push(branch);
		if (!(await isMerged(cwd, branch))) problems.push(branch);
	}
	if (problems.length > 0) {
		return { ok: false, deleted: [], problems };
	}
	for (const branch of existing) {
		await deleteMergedBranch(cwd, branch);
	}
	return { ok: true, deleted: existing, problems: [] };
}
