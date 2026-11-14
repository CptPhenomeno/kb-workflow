/**
 * Pure usage-ledger module (FR-27): append-only JSONL persistence of every
 * subagent round and the pure aggregations FR-29 (/kb-dev report) and FR-30
 * (/kb-cost) consume.
 *
 * Constraints (SPEC v0.2.1):
 * - NFR-15: no ledger failure ever throws out of this module — a missing,
 *   unreadable or corrupt ledger degrades to skipping records on read and
 *   to running unrecorded on write.
 * - NFR-16: only Node builtins (fs), no new dependency.
 * - NFR-17: no pi imports — this file must stay unit-testable in isolation.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

/** The per-round usage numbers captured from the subagent's usage events. */
export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/** One ledger record per subagent round (FR-27). */
export interface UsageRecord {
	/** Identifies the /kb-dev invocation (or the individual kb_agent call). */
	runId: string;
	/** ISO timestamp of the round. */
	at: string;
	/** The subagent name, e.g. `kb-developer` (FR-27); the kb claim
	 * actor is not stored — it is recomputable from `agent` + `item`
	 * via `actorForAgent(agent)`, plus `-<item>` when one is targeted. */
	agent: string;
	/** planner / developer / reviewer / qa. */
	role: string;
	model: string;
	thinkingLevel: string;
	/** The kb item ID when the round targets one, `null` otherwise. */
	item: string | null;
	/** `false` for failed rounds — they are recorded too (FR-28). */
	ok: boolean;
	usage: Usage;
}

/** Aggregated totals over a set of records, cache read/write kept separate. */
export interface UsageTotals extends Usage {
	/** Number of rounds that contributed to these totals. */
	rounds: number;
}

function isUsage(value: unknown): value is Usage {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const usage = value as Record<string, unknown>;
	return (
		typeof usage.input === "number" &&
		typeof usage.output === "number" &&
		typeof usage.cacheRead === "number" &&
		typeof usage.cacheWrite === "number" &&
		typeof usage.cost === "number" &&
		typeof usage.turns === "number"
	);
}

function isUsageRecord(value: unknown): value is UsageRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.runId === "string" &&
		typeof record.at === "string" &&
		typeof record.agent === "string" &&
		typeof record.role === "string" &&
		typeof record.model === "string" &&
		typeof record.thinkingLevel === "string" &&
		(record.item === null || typeof record.item === "string") &&
		typeof record.ok === "boolean" &&
		isUsage(record.usage)
	);
}

/**
 * Append one JSON line to the ledger. The file is never rewritten: existing
 * content stays byte-identical (append-only, FR-27). Any write failure is
 * swallowed — the round runs unrecorded rather than crashing (NFR-15).
 */
export function appendRecord(ledgerPath: string, record: UsageRecord): void {
	try {
		mkdirSync(path.dirname(ledgerPath), { recursive: true });
		appendFileSync(ledgerPath, JSON.stringify(record) + "\n");
	} catch {
		// NFR-15: a ledger write failure never fails the round or the run.
	}
}

/**
 * Read the ledger, skipping malformed lines. Returns `[]` for a missing or
 * unreadable file; never throws (NFR-15).
 */
export function readRecords(ledgerPath: string): UsageRecord[] {
	let content: string;
	try {
		content = readFileSync(ledgerPath, "utf8");
	} catch {
		return [];
	}

	const records: UsageRecord[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // malformed line: skip it
		}
		if (isUsageRecord(parsed)) {
			records.push(parsed);
		}
	}
	return records;
}

function emptyTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		rounds: 0,
	};
}

function addRecord(totals: UsageTotals, record: UsageRecord): void {
	totals.input += record.usage.input;
	totals.output += record.usage.output;
	totals.cacheRead += record.usage.cacheRead;
	totals.cacheWrite += record.usage.cacheWrite;
	totals.cost += record.usage.cost;
	totals.turns += record.usage.turns;
	totals.rounds += 1;
}

/**
 * Sum usage over records: overall tokens and euros, cacheRead and cacheWrite
 * kept separate so the effective cost is interpretable (FR-29).
 */
export function sumUsage(records: readonly UsageRecord[]): UsageTotals {
	const totals = emptyTotals();
	for (const record of records) {
		addRecord(totals, record);
	}
	return totals;
}

/**
 * Group records by role (planner/developer/reviewer/qa) with per-group
 * totals — the per-role breakdown of FR-29 and FR-30.
 */
export function aggregateByRole(
	records: readonly UsageRecord[],
): Map<string, UsageTotals> {
	return aggregateBy(records, (record) => record.role);
}

/**
 * Group records by model with per-group totals — the per-model breakdown of
 * FR-30.
 */
export function aggregateByModel(
	records: readonly UsageRecord[],
): Map<string, UsageTotals> {
	return aggregateBy(records, (record) => record.model);
}

function aggregateBy(
	records: readonly UsageRecord[],
	keyOf: (record: UsageRecord) => string,
): Map<string, UsageTotals> {
	const groups = new Map<string, UsageTotals>();
	for (const record of records) {
		const key = keyOf(record);
		let totals = groups.get(key);
		if (!totals) {
			totals = emptyTotals();
			groups.set(key, totals);
		}
		addRecord(totals, record);
	}
	return groups;
}
