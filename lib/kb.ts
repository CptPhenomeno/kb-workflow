/**
 * Thin wrapper around the `kb` CLI.
 *
 * Every call runs `kb <args> --json` (unless disabled) and parses stdout.
 * Exit codes are documented in docs/cli-json.md of the kb repo:
 *   0 ok, 1 error, 2 not found (also: `kb next` found nothing),
 *   3 requirements not met, 4 version conflict, 5 claimed by another actor.
 */

import { spawn } from "node:child_process";

export interface KbItem {
	id: string;
	ref: string | null;
	type: "epic" | "story" | "task" | "subtask" | "bug";
	title: string;
	description: string;
	parent: string | null;
	status: "backlog" | "todo" | "doing" | "review" | "done";
	priority: "high" | "medium" | "low";
	points: number | null;
	spec: string | null;
	labels: string[];
	links: string[];
	acceptance: Array<{ text: string; done: boolean }>;
	tests: Array<{ name: string; state: "pending" | "failing" | "passing" }>;
	tdd_phase: "red" | "green" | "refactor" | null;
	assignee: string | null;
	claim: { actor: string; expires_at: string; stale: boolean } | null;
	blocked_by: string[];
	blocks: string[];
	relates: string[];
	duplicates: string[];
	position: number;
	version: number;
	created_at: string;
	created_by: string;
	updated_at: string;
	updated_by: string;
}

export interface KbRun {
	code: number | null;
	stdout: string;
	stderr: string;
	/** Parsed stdout when the command printed valid JSON, undefined otherwise. */
	json: unknown;
}

export interface RunKbOptions {
	/** Append `--json` to the arguments (default true). */
	json?: boolean;
	/** Extra environment variables for the kb process. */
	env?: NodeJS.ProcessEnv;
}

export function runKb(args: string[], cwd: string, opts?: RunKbOptions): Promise<KbRun> {
	const wantJson = opts?.json !== false;
	const finalArgs = wantJson ? [...args, "--json"] : args;
	return new Promise((resolve) => {
		const proc = spawn("kb", finalArgs, {
			cwd,
			shell: false,
			env: { ...process.env, ...opts?.env },
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		proc.on("error", (err) => {
			resolve({ code: null, stdout, stderr: stderr + String(err), json: undefined });
		});
		proc.on("close", (code) => {
			let json: unknown;
			try {
				json = JSON.parse(stdout);
			} catch {
				json = undefined;
			}
			resolve({ code, stdout, stderr, json });
		});
	});
}

/** Human-readable message for a failed kb run (uses the stable `error` JSON shape when present). */
export function kbErrorMessage(r: KbRun): string {
	const j = r.json as { error?: string; message?: string; unmet?: string[] } | undefined;
	if (j?.error) {
		const unmet = j.unmet?.length ? ` unmet: ${j.unmet.join("; ")}` : "";
		return `${j.error}: ${j.message ?? ""}${unmet}`;
	}
	return (r.stderr || r.stdout).trim() || `exit code ${r.code}`;
}

/** True when the item is open (not done). */
export function isOpen(item: KbItem): boolean {
	return item.status !== "done";
}

/** True when the item has no open blockers (directly or via ancestors). */
export function isUnblocked(item: KbItem): boolean {
	return (item.blocked_by ?? []).length === 0;
}
