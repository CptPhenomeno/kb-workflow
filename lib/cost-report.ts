/**
 * Cost reporting (FR-29 / FR-30 / AC-35 / AC-36): the pure renderers for
 * the token/euro spend — the cumulative /kb-cost table across all runs and
 * the "Usage this run" block appended to the /kb-dev report.
 *
 * The /kb-cost output is delivered through the TUI-only entry channel
 * (FR-30, amended 2026-11-14): `pi.appendEntry` on the dedicated `kb-usage`
 * type plus the shared entry renderer (lib/usage-entry-renderer.ts), which
 * renders the markdown with the real Markdown component inside a
 * customMessageBg block, GFM tables included. Custom entries do NOT
 * participate in LLM context, so the table never reaches the model. The
 * table layout reproduces the validated prototype
 * (prototype/kb-tui-prototype.mjs, key `c`, table layout) faithfully.
 *
 * Pure Node builtins, no pi imports (NFR-17): the command reads the ledger
 * through the pure lib/usage-ledger.ts and this module stays unit-testable
 * in isolation. An empty or missing ledger renders the same table with
 * zeros, never an error (NFR-15).
 */

import { ledgerPathFor } from "./round-ledger.ts";
import { appendUsageEntry, type AppendEntry } from "./usage-entry.ts";
import {
	aggregateByRole,
	readRecords,
	sumUsage,
	type UsageRecord,
	type UsageTotals,
} from "./usage-ledger.ts";

/** Dependencies of the command, injectable for tests. */
export interface CostCommandDeps {
	/** The project root; the ledger sits in `<cwd>/.pi/kb-usage.jsonl`. */
	cwd: string;
	/** The extension's `pi.appendEntry` seam (the TUI-only channel). */
	appendEntry: AppendEntry;
}

/** One table row: the (role, model) pair with its aggregated totals. */
interface CostRow {
	role: string;
	model: string;
	totals: UsageTotals;
}

/** Token formatter, faithful to the prototype: 1.9M / 95k / 0. */
function fmtTok(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return `${n}`;
}

/** Euro formatter, faithful to the prototype: €7.84. */
function fmtEuro(n: number): string {
	return `€${n.toFixed(2)}`;
}

const EMPTY_TOTALS: UsageTotals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
	rounds: 0,
};

/**
 * Group the records into one row per (role, model) pair, in order of first
 * appearance — the per-role and per-model breakdown of FR-30. A role that
 * ran several models gets one row per model.
 */
export function costRows(records: readonly UsageRecord[]): CostRow[] {
	const rows = new Map<string, CostRow>();
	for (const record of records) {
		const key = `${record.role}\u0000${record.model}`;
		let row = rows.get(key);
		if (!row) {
			row = { role: record.role, model: record.model, totals: { ...EMPTY_TOTALS } };
			rows.set(key, row);
		}
		const t = row.totals;
		t.input += record.usage.input;
		t.output += record.usage.output;
		t.cacheRead += record.usage.cacheRead;
		t.cacheWrite += record.usage.cacheWrite;
		t.cost += record.usage.cost;
		t.turns += record.usage.turns;
		t.rounds += 1;
	}
	return [...rows.values()];
}

/**
 * Render the cumulative cost report as markdown (FR-30): a header naming the
 * number of runs, then a GFM table with one row per (role, model) pair and a
 * bold totals row with the overall tokens and euros. An empty record set
 * renders the same table with zeros (NFR-15).
 */
export function renderCostReport(records: readonly UsageRecord[]): string {
	const rows = costRows(records);
	const runs = new Set(records.map((record) => record.runId)).size;

	const total = sumUsage(records);

	const lines: string[] = [
		`**kb-cost — cumulative across ${runs} runs**`,
		"",
		"| role | model | tokens in/out (cache r/w) | cost |",
		"|---|---|---|---|",
	];
	for (const row of rows) {
		const t = row.totals;
		lines.push(
			`| ${row.role} | ${row.model} | ${fmtTok(t.input)}/${fmtTok(t.output)} (${fmtTok(t.cacheRead)}/${fmtTok(t.cacheWrite)}) | ${fmtEuro(t.cost)} |`,
		);
	}
	lines.push(
		`| **total** | | **${fmtTok(total.input)}/${fmtTok(total.output)} (${fmtTok(total.cacheRead)}/${fmtTok(total.cacheWrite)})** | **${fmtEuro(total.cost)}** |`,
	);
	return lines.join("\n");
}

/**
 * Render the "Usage this run" block appended to the final /kb-dev report
 * (FR-29 / AC-35): this run's token totals and euro cost with cacheRead and
 * cacheWrite stated separately, plus a per-role breakdown. The block layout
 * reproduces the validated prototype (prototype/kb-tui-prototype.mjs, key
 * `t`, block variant) faithfully:
 *
 *   **Usage this run**
 *   - tokens: X in / Y out · cache A read / B write
 *   - cost: **€Z** — developer €d · reviewer €r
 *
 * The caller passes only this run's records (filtered by runId); an empty
 * record set renders the same block with zeros and no per-role list (a run
 * that recorded no rounds, NFR-15).
 */
export function renderRunUsageBlock(records: readonly UsageRecord[]): string {
	const total = sumUsage(records);
	const byRole = aggregateByRole(records);

	const lines: string[] = [
		"**Usage this run**",
		`- tokens: ${fmtTok(total.input)} in / ${fmtTok(total.output)} out · cache ${fmtTok(total.cacheRead)} read / ${fmtTok(total.cacheWrite)} write`,
	];
	const perRole = [...byRole.entries()].map(([role, t]) => `${role} ${fmtEuro(t.cost)}`);
	lines.push(
		perRole.length > 0
			? `- cost: **${fmtEuro(total.cost)}** — ${perRole.join(" · ")}`
			: `- cost: **${fmtEuro(total.cost)}**`,
	);
	return lines.join("\n");
}

/**
 * The /kb-cost command: read the ledger (a missing or unreadable one
 * degrades to an empty record set, NFR-15) and render the cumulative totals
 * as markdown through the TUI-only entry channel — a custom entry that
 * never enters the LLM context, so no isIdle guard is needed.
 */
export function runCostCommand(deps: CostCommandDeps): void {
	const ledgerPath = ledgerPathFor(deps.cwd);
	const records = readRecords(ledgerPath);
	appendUsageEntry(deps.appendEntry, renderCostReport(records));
}
