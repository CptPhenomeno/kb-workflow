/**
 * Round recorder for the usage ledger (FR-28 / AC-34 / NFR-15).
 *
 * Both spawn paths — the /kb-dev orchestration rounds (lib/dispatch.ts,
 * bare and message mode) and every kb_agent tool invocation
 * (lib/agent-tool.ts, wired from index.ts) — record one ledger entry per
 * subagent round through this module: successful and failed rounds alike,
 * with the run, item, role, model, thinking level, tokens and cost of
 * FR-27. The write is best-effort: a ledger failure is swallowed and never
 * fails the round or the run (NFR-15).
 *
 * Pure Node builtins, no pi imports (NFR-17): the record is built here from
 * the data the dispatch seams already hold, and appended through the pure
 * `appendRecord` of lib/usage-ledger.ts.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { appendRecord, type Usage, type UsageRecord } from "./usage-ledger.ts";
import { roleOf } from "./agent-tool.ts";
import { actorForAgent, type KbAgentName, type SubagentUsage } from "./subagent.ts";

/** The ledger location (FR-27): `<project>/.pi/kb-usage.jsonl`. */
export function ledgerPathFor(cwd: string): string {
	return path.join(cwd, ".pi", "kb-usage.jsonl");
}

/** A fresh run id: identifies one /kb-dev invocation or kb_agent call. */
export function newRunId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

const ITEM_PATTERN = /\bKB-[0-9]+\b/i;

/**
 * Best-effort extraction of the kb item ID a task targets (FR-27 `item`):
 * the first `KB-<n>` mentioned in the task text, or null when the task
 * targets no item (e.g. a kb_agent call without one).
 */
export function itemFromTask(task: string): string | null {
	const match = task.match(ITEM_PATTERN);
	return match ? match[0].toUpperCase() : null;
}

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

/** What a spawn path knows about one round when it completes. */
export interface RoundRecordInput {
	/** Identifies the /kb-dev invocation or the individual kb_agent call. */
	runId: string;
	agent: KbAgentName;
	/** The kb item ID the round targets, null when it targets none. */
	item: string | null;
	/** The resolved model and thinking level the round ran with (FR-20). */
	resolved: { model?: string; thinkingLevel?: string };
	/** The round outcome; a failed round is recorded with `ok: false`. */
	result: { ok: boolean; usage?: SubagentUsage };
}

/**
 * Build the FR-27 record for one round. Properties that did not resolve to
 * a concrete value (neither from the config nor from the session) are
 * recorded as `"unknown"` — the record shape requires strings.
 */
export function roundRecord(input: RoundRecordInput): UsageRecord {
	const actor = actorForAgent(input.agent);
	return {
		runId: input.runId,
		at: new Date().toISOString(),
		agent: input.item ? `${actor}-${input.item}` : actor,
		role: roleOf(input.agent),
		model: input.resolved.model ?? "unknown",
		thinkingLevel: input.resolved.thinkingLevel ?? "unknown",
		item: input.item,
		ok: input.result.ok,
		usage: input.result.usage ?? { ...ZERO_USAGE },
	};
}

/**
 * Persist one round to the ledger, best-effort (FR-28 / NFR-15): any
 * failure — building or appending the record — is swallowed; the round and
 * the run continue unrecorded.
 */
export function recordRound(ledgerPath: string, input: RoundRecordInput): void {
	try {
		appendRecord(ledgerPath, roundRecord(input));
	} catch {
		// NFR-15: a ledger write failure never fails the round or the run.
	}
}
