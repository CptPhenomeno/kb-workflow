/**
 * kb-workflow — pi extension that drives the `kb` kanban board end to end.
 *
 * Commands:
 *   /kb-plan [idea]  Interactive analysis with the user (via the ask_user tool),
 *                    then SPEC.md is written/versioned at the project root and the
 *                    kb-planner subagent turns it into plan.yaml + kb board import.
 *   /kb-dev [msg]    Completes pending reviews, then either works the next
 *                    available story per the kb DAG (FR-11 chain: epic-scoped
 *                    story -> board-wide story -> single task/bug): every task
 *                    gets a kb-developer round on its own branch and a
 *                    kb-reviewer round with merge into develop — one story
 *                    per invocation; or, with a message argument,
 *                    delivers the message to the main agent as a kickoff that
 *                    identifies and works the pertinent items in DAG order.
 *   /kb-cost         Prints the cumulative token and euro spend across all runs
 *                    from the usage ledger, per role and per model, as a
 *                    markdown table (an empty ledger prints zeros). Delivered
 *                    TUI-only (appendEntry + entry renderer): the table never
 *                    enters the LLM context, so the command works while the
 *                    agent is busy.
 *
 * Tools (callable by the LLM):
 *   ask_user         Ask the user a question (input / select / multi-select).
 *   kb_agent         Run a kb-planner / kb-developer / kb-reviewer / kb-qa subagent
 *                    in an isolated pi process.
 *
 * Model config (v0.2.0 `kb-agents` format): the kb-workflow.json shipped in
 * the extension's own folder, merged with the project-local
 * <project>/.pi/kb-workflow.json override (later wins, per single property).
 * Each of the four roles is an object with
 * two optional properties, resolved independently per role:
 *   {
 *     "kb-agents": {
 *       "planner":   { "model": "provider/model", "thinking-level": "high" },
 *       "developer": { "model": "provider/model", "thinking-level": "medium" },
 *       "reviewer":  { "model": "provider/model", "thinking-level": "low" },
 *       "qa":        { "model": "provider/model", "thinking-level": "low" }
 *     }
 *   }
 * A missing model falls back to the model active in the dispatching pi session;
 * a missing (or invalid) thinking level falls back to that session's thinking
 * level — always forwarded, including when the model is explicitly configured
 * (FR-20). The old `models` format is no longer supported (FR-17).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { executeKbAgent, kbAgentToolResult } from "./lib/agent-tool.ts";
import { runCostCommand } from "./lib/cost-report.ts";
import { settleKickoffWindow } from "./lib/kickoff-window.ts";
import { registerUsageEntryRenderer } from "./lib/usage-entry-renderer.ts";
import { loadKbWorkflowConfig } from "./lib/config-load.ts";
import { kbErrorMessage, runKb } from "./lib/kb.ts";
import { preFlightCheck } from "./lib/git.ts";
import { dispatchDev } from "./lib/dispatch.ts";
import { ledgerPathFor } from "./lib/round-ledger.ts";
import { runSubagent, type KbAgentName } from "./lib/subagent.ts";

const AgentParam = StringEnum(["kb-planner", "kb-developer", "kb-reviewer", "kb-qa"] as const, {
	description: "Which kb subagent to run",
});

const textResult = (t: string) => ({
	content: [{ type: "text" as const, text: t }],
	details: { answer: t },
});

function planKickoff(idea: string): string {
	return `The user wants to build:

"""
${idea}
"""

PHASE 1 — INTERACTIVE ANALYSIS
Interview the user to pin down the specification. Use the \`ask_user\` tool for every question: one at a time, short and targeted; pass \`options\` when there are sensible choices and \`multiple: true\` when several can be picked. Cover at least: goal and context, users/actors, functional requirements, non-functional requirements (performance, security, ...), verifiable acceptance criteria, dependencies and constraints, priorities, and what is explicitly OUT of scope. Do not proceed until the specification is clear and complete.

PHASE 2 — CONFIRMATION
When you believe the spec is complete, ask the user for explicit confirmation with \`ask_user\` (e.g. options "Yes, proceed" / "No, details are missing"). If they want changes, go back to PHASE 1.

PHASE 3 — SPEC.md
Write the result to \`SPEC.md\` at the project root (the cwd):
- If SPEC.md does not exist: create it with a title, a short intro, and a first section \`## v1 — <ISO date>\` containing the full specification.
- If it exists: DO NOT delete or rewrite previous sections. Append at the END a new section \`## vN — <ISO date>\` (N = next version number) with the new version of the specification, starting with a line \`Changes vs v(N-1): ...\` summarizing what changed. Sections v1..v(N-1) stay untouched as history.

PHASE 4 — KANBAN PLANNING
Call the \`kb_agent\` tool with agent "kb-planner" and a task that instructs it to: read the latest version of SPEC.md, generate \`plan.yaml\` at the project root following the plan format documented in \`kb guide\`, validate it with \`kb import plan.yaml --dry-run\`, and import it into the board (run \`kb init\` if \`.kanban/\` is missing; use \`kb import plan.yaml --update\` when the refs already exist on the board).
Finally, report to the user: the plan structure (epics/stories/tasks) and the import result.`;
}

export default function kbWorkflow(pi: ExtensionAPI) {
	// ---------------------------------------------------------------------------
	// TUI-only usage channel (FR-30 / AC-39): register the shared entry
	// renderer for `kb-usage` custom entries. Custom entries never enter the
	// LLM context, so the usage reports (/kb-cost, and the FR-29 message-mode
	// "Usage this run" block) are displayed but never billed to the model.
	// ---------------------------------------------------------------------------
	registerUsageEntryRenderer(pi);

	// ---------------------------------------------------------------------------
	// FR-29 (amended, KB-61 / AC-38): when the kickoff run settles, emit the
	// "Usage this run" block for the kickoff window's records through the
	// TUI-only channel and close the window. ctx.isIdle() is true here; a
	// missing window (e.g. after an extension reload) is a no-op.
	// ---------------------------------------------------------------------------
	pi.on("agent_settled", (_event, ctx) => {
		settleKickoffWindow({ cwd: ctx.cwd, appendEntry: (customType, data) => pi.appendEntry(customType, data) });
	});

	// ---------------------------------------------------------------------------
	// Tool: ask_user — ask the user a question through the TUI dialogs.
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question and wait for the answer. Use whenever you need user input to proceed " +
			"(e.g. during the /kb-plan analysis phase). Without `options` it shows a free-text input; with `options` " +
			"a single-choice selector; `multiple: true` allows picking several options.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ description: "Display label for the option" }),
						description: Type.Optional(Type.String({ description: "Optional description shown next to the label" })),
					}),
					{ description: "Options to choose from. Omit for a free-text input." },
				),
			),
			multiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default false)", default: false })),
		}),
		executionMode: "sequential", // touches the UI: never run in parallel with other UI tools
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				return textResult("Error: interactive UI is not available in this run mode.");
			}

			// Free-text input.
			if (!params.options || params.options.length === 0) {
				const answer = await ctx.ui.input(params.question);
				return textResult(answer === undefined ? "(cancelled)" : answer);
			}

			const labels = params.options.map((o) => (o.description ? `${o.label} — ${o.description}` : o.label));

			// Single choice + "custom answer" escape hatch.
			if (!params.multiple) {
				const FREE = "✎ Type a custom answer";
				const choice = await ctx.ui.select(params.question, [...labels, FREE]);
				if (choice === undefined) return textResult("(cancelled)");
				if (choice === FREE) {
					const answer = await ctx.ui.input(params.question);
					return textResult(answer === undefined ? "(cancelled)" : answer);
				}
				return textResult(choice);
			}

			// Multi choice: checkbox list.
			const picked = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
				let index = 0;
				const checked = new Set<number>();
				return {
					handleInput(data: string) {
						if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
						else if (matchesKey(data, Key.down)) index = Math.min(labels.length - 1, index + 1);
						else if (data === " ") {
							if (checked.has(index)) checked.delete(index);
							else checked.add(index);
						} else if (matchesKey(data, Key.enter)) {
							done([...checked].sort((a, b) => a - b).map((i) => labels[i]));
						} else if (matchesKey(data, Key.escape)) done(null);
						tui.requestRender();
					},
					render(_width: number): string[] {
						const lines = [theme.fg("accent", params.question), ""];
						labels.forEach((label, i) => {
							const line = `${checked.has(i) ? "[x]" : "[ ]"} ${label}`;
							lines.push(i === index ? theme.fg("accent", line) : line);
						});
						lines.push("", theme.fg("dim", "space: toggle · enter: confirm · esc: cancel"));
						return lines;
					},
				};
			});
			if (picked === null) return textResult("(cancelled)");
			return textResult(picked.length ? picked.join(", ") : "(none selected)");
		},
	});

	// ---------------------------------------------------------------------------
	// Tool: kb_agent — run a specialized subagent in an isolated pi process.
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "kb_agent",
		label: "KB Agent",
		description:
			"Run a specialized kb subagent in an isolated pi process. The subagent gets its own system prompt plus " +
			"`kb guide`, runs in the project cwd and reports on the kb board as agent-plan / agent-dev / agent-review / agent-qa. " +
			"Use kb-planner after SPEC.md is written; kb-developer to implement one kanban item; kb-reviewer to review " +
			"an item sitting in the review column; kb-qa to review a story or epic in the review column, verify the " +
			"merged work on develop, delete merged task branches and move it to done/todo.",
		parameters: Type.Object({
			agent: AgentParam,
			task: Type.String({
				description: "Complete, self-contained task for the subagent (include item IDs, file paths, expectations)",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agent = params.agent as KbAgentName;
			const config = loadKbWorkflowConfig(ctx.cwd);
			const session = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const res = await executeKbAgent({
				agent,
				task: params.task,
				config,
				session,
				// Every kb_agent invocation is persisted to the usage ledger
				// (FR-28), best-effort: a ledger failure never fails the round.
				// The FR-27 location has one source of truth: ledgerPathFor; the
				// runId inherits the open kickoff window when one is (FR-27/FR-29).
				ledgerPath: ledgerPathFor(ctx.cwd),
				runSubagent: (opts) =>
					runSubagent({
						...opts,
						cwd: ctx.cwd,
						signal,
						onUpdate: (t) => onUpdate?.({ content: [{ type: "text", text: t }], details: { agent, running: true } }),
					}),
			});
			// FR-31: the result carries the round's usage in pi's `Usage`
			// shape on the field pi accounts a tool's spend from, so pi
			// persists it and includes it in the session totals (footer,
			// /session, RPC); `details.usage` keeps feeding the rendering.
			return kbAgentToolResult(res);
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /kb-plan [idea]
	// ---------------------------------------------------------------------------
	pi.registerCommand("kb-plan", {
		description:
			"Analyze an idea with the user (ask_user), write/version SPEC.md at the project root, then plan the kb kanban via the kb-planner subagent",
		handler: async (args, ctx) => {
			let idea = args.trim();
			if (!idea) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify("Usage: /kb-plan <idea>", "warning");
					return;
				}
				idea = (await ctx.ui.input("What do you want to build?"))?.trim() ?? "";
				if (!idea) {
					ctx.ui.notify("No idea provided.", "warning");
					return;
				}
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy; try again when idle.", "warning");
				return;
			}
			pi.sendUserMessage(planKickoff(idea));
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /kb-dev [message] — bare mode works one story per invocation
	// (FR-11, superseding FR-9); message mode delivers a kickoff to the main
	// agent (FR-10).
	// ---------------------------------------------------------------------------
	pi.registerCommand("kb-dev", {
		description:
			"Work the next available kb element (kb next, board level): a kb-developer subagent implements it (kb resolves the DAG via blockers), then a kb-reviewer subagent reviews and merges it; items left in review are completed first, routed by type (tasks/subtasks to kb-reviewer, stories/epics to kb-qa, which also runs when the worked item's story or epic completes). With a message argument, the message is delivered to the main agent as a kickoff that identifies and works the pertinent items in DAG order and spawns kb-qa rounds for stories/epics reaching review",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is busy; try again when idle.", "warning");
				return;
			}
			const cwd = ctx.cwd;

			// Pre-flight (FR-1, AC-1): a dirty tree aborts the run before any
			// board or git action; a clean tree checks out develop first.
			const pre = await preFlightCheck(cwd);
			if (!pre.ok) {
				ctx.ui.notify(`${pre.error} Aborting: no action was taken.`, "error");
				return;
			}

			// Preconditions: an initialized board and a SPEC.md.
			const listRes = await runKb(["list"], cwd);
			if (listRes.code !== 0) {
				ctx.ui.notify(`No kb board in this project (${kbErrorMessage(listRes)}). Run /kb-plan first.`, "error");
				return;
			}
			if (!fs.existsSync(path.join(cwd, "SPEC.md"))) {
				ctx.ui.notify("SPEC.md not found at the project root. Run /kb-plan first.", "error");
				return;
			}

			// Per-role model and thinking-level resolution (FR-20): the
			// dispatchers resolve each role against this config and session
			// and forward both properties to runSubagent (FR-21).
			const config = loadKbWorkflowConfig(cwd);
			const session = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};

			ctx.ui.setStatus("kb-dev", "running");
			let report: string;
			let delivered = true;
			try {
				// Mode dispatch (FR-11 vs FR-10): a bare invocation resolves the
				// next unit via the epic -> story -> task chain and works one
				// story (or fallback task/bug) per invocation; a message argument
				// hands the message to the main agent as a kickoff.
				// Exactly one mode runs.
				const result = await dispatchDev({
					args,
					cwd,
					config,
					session,
					kb: (a) => runKb(a, cwd),
					preFlight: () => preFlightCheck(cwd),
					runSubagent: (opts) => runSubagent({ ...opts, cwd }),
					sendUserMessage: (text) => pi.sendUserMessage(text),
					notify: (msg, level) => ctx.ui.notify(msg, level),
					setStatus: (status) => ctx.ui.setStatus("kb-dev", status),
				});
				report = result.report;
				delivered = result.delivered ?? true;
			} finally {
				ctx.ui.setStatus("kb-dev", undefined);
			}

		ctx.ui.notify(
			delivered ? "Finished the /kb-dev run. See the report in chat." : "/kb-dev aborted; see the report in chat.",
			"info",
		);
		pi.sendMessage({ customType: "kb-workflow", content: report, display: true });
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /kb-cost — cumulative token/euro totals as a markdown table
	// (FR-30 / AC-36 / AC-39).
	// ---------------------------------------------------------------------------
	pi.registerCommand("kb-cost", {
		description:
			"Print the cumulative token and euro spend across all runs from the usage ledger, broken down per role and per model, as a markdown table (an empty ledger prints zeros)",
		handler: async (_args, ctx) => {
			// TUI-only delivery (FR-30 / AC-39): the table is a custom entry
			// rendered by the shared entry renderer — it never enters the LLM
			// context, so no isIdle guard is needed and the command is usable
			// while the agent is busy. A missing or unreadable ledger degrades
			// to zeros (NFR-15).
			runCostCommand({ cwd: ctx.cwd, appendEntry: (customType, data) => pi.appendEntry(customType, data) });
		},
	});
}
