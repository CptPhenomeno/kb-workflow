/**
 * kb-workflow — pi extension that drives the `kb` kanban board end to end.
 *
 * Commands:
 *   /kb-plan [idea]  Interactive analysis with the user (via the ask_user tool),
 *                    then SPEC.md is written/versioned at the project root and the
 *                    kb-planner subagent turns it into plan.yaml + kb board import.
 *   /kb-dev [msg]    Completes pending reviews, then either works the next
 *                    available board-level element (kb next): a kb-developer
 *                    subagent implements it (kb resolves the DAG via blockers),
 *                    then a kb-reviewer subagent reviews and merges it — one
 *                    element per invocation; or, with a message argument,
 *                    delivers the message to the main agent as a kickoff that
 *                    identifies and works the pertinent items in DAG order.
 *
 * Tools (callable by the LLM):
 *   ask_user         Ask the user a question (input / select / multi-select).
 *   kb_agent         Run a kb-planner / kb-developer / kb-reviewer subagent in an
 *                    isolated pi process.
 *
 * Model config: <agentDir>/kb-workflow.json merged with <project>/.pi/kb-workflow.json
 *   { "models": { "planner": "provider/model", "developer": "...", "reviewer": "..." } }
 * Missing roles inherit the active model of the dispatching session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadKbWorkflowConfig, resolveAgentModel, type AgentRole } from "./lib/config.ts";
import { kbErrorMessage, runKb, type KbItem } from "./lib/kb.ts";
import { preFlightCheck } from "./lib/git.ts";
import { runBareDev, type BareModeResult } from "./lib/bare-mode.ts";
import { runMessageDev, type MessageModeResult } from "./lib/message-mode.ts";
import { actorForAgent, runSubagent, type KbAgentName } from "./lib/subagent.ts";

const AgentParam = StringEnum(["kb-planner", "kb-developer", "kb-reviewer"] as const, {
	description: "Which kb subagent to run",
});

const roleOf = (agent: KbAgentName): AgentRole => agent.replace("kb-", "") as AgentRole;

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

function devTask(task: KbItem, story?: KbItem | null): string {
	const where = story
		? ` of story ${story.id} ("${story.title}")`
		: "";
	return [
		`Implement kanban item ${task.id} ("${task.title}")${where} in the project rooted at the cwd.`,
		``,
		`Follow your system prompt (kb-developer) and the appended kb guide exactly:`,
		`- claim the item as agent-dev-${task.id}`,
		`- run \`kb show ${task.id} --json\` and read its spec link (e.g. SPEC.md#...) before coding`,
		`- TDD loop: phase red -> write failing tests -> test fail -> phase green -> implement -> test pass -> phase refactor -> accept check -> note -> move to review`,
		`- if a move is refused (exit code 3), satisfy every entry in \`unmet\`; never work around the rules`,
		`- renew the claim with \`kb touch ${task.id}\` during long work`,
		``,
		`Finish with a short summary: files changed, tests run and their result, final board status of ${task.id}. Do not touch other board items.`,
	].join("\n");
}

function reviewTask(item: KbItem): string {
	return [
		`Review kanban item ${item.id} ("${item.title}"), currently in the "review" column, in the project rooted at the cwd.`,
		``,
		`Follow your system prompt (kb-reviewer) and the appended kb guide exactly:`,
		`- act as agent-review-${item.id}`,
		`- run \`kb show ${item.id} --json\`; all declared tests must be passing`,
		`- re-run the project test suite yourself and check \`git diff\` for quality issues`,
		`- if OK: check all acceptance criteria, add a note, move the item to done`,
		`- if problems: add a note listing them and move the item back to todo (or leave in review if the move is refused)`,
		``,
		`Finish with the verdict (OK / problems) and the final board status of ${item.id}. Do not implement fixes yourself.`,
	].join("\n");
}

export default function kbWorkflow(pi: ExtensionAPI) {
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
			"`kb guide`, runs in the project cwd and reports on the kb board as agent-plan / agent-dev / agent-review. " +
			"Use kb-planner after SPEC.md is written; kb-developer to implement one kanban item; kb-reviewer to review " +
			"an item sitting in the review column.",
		parameters: Type.Object({
			agent: AgentParam,
			task: Type.String({
				description: "Complete, self-contained task for the subagent (include item IDs, file paths, expectations)",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agent = params.agent as KbAgentName;
			const config = loadKbWorkflowConfig(ctx.cwd);
			const fallback = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const model = resolveAgentModel(roleOf(agent), config, fallback);
			const res = await runSubagent({
				agent,
				task: params.task,
				cwd: ctx.cwd,
				model,
				thinkingLevel: model === fallback ? ctx.thinkingLevel : undefined,
				signal,
				onUpdate: (t) => onUpdate?.({ content: [{ type: "text", text: t }], details: { agent, running: true } }),
			});
			const header = res.ok
				? `Subagent ${agent} completed.`
				: `Subagent ${agent} FAILED (exit ${res.exitCode}${res.errorMessage ? `: ${res.errorMessage}` : ""}).`;
			const stderr = res.stderr.trim();
			return {
				content: [{ type: "text", text: `${header}\n\n${res.output}${stderr ? `\n\nstderr:\n${stderr}` : ""}` }],
				details: { ok: res.ok, agent, actor: res.actor, exitCode: res.exitCode, usage: res.usage },
			};
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
	// Command: /kb-dev [message] — bare mode works one board-level element per
	// invocation (FR-9); message mode delivers a kickoff to the main agent (FR-10).
	// ---------------------------------------------------------------------------
	pi.registerCommand("kb-dev", {
		description:
			"Work the next available kb element (kb next, board level): a kb-developer subagent implements it (kb resolves the DAG via blockers), then a kb-reviewer subagent reviews and merges it; items left in review are completed first. With a message argument, the message is delivered to the main agent as a kickoff that identifies and works the pertinent items in DAG order",
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

			// Models for the subagents (same resolution rules as v0.1.0, NFR-6).
			const config = loadKbWorkflowConfig(cwd);
			const fallbackModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const devModel = resolveAgentModel("developer", config, fallbackModel);
			const revModel = resolveAgentModel("reviewer", config, fallbackModel);

			// Resolve the parent story of a task for its dev prompt (best effort).
			const storyCache = new Map<string, KbItem | null>();
			const storyOf = async (task: KbItem): Promise<KbItem | null> => {
				if (!task.parent) return null;
				if (storyCache.has(task.parent)) return storyCache.get(task.parent) ?? null;
				const res = await runKb(["show", task.parent], cwd);
				const story = (res.code === 0 ? res.json : undefined) as KbItem | undefined;
				storyCache.set(task.parent, story ?? null);
				return story ?? null;
			};

		const message = args.trim();
		const spawnReviewer = (item: KbItem) =>
			runSubagent({ agent: "kb-reviewer", cwd, model: revModel, task: reviewTask(item) });

		ctx.ui.setStatus("kb-dev", "running");
		let report: string;
		let delivered = true;
		try {
			if (message) {
				// Message mode (FR-10): pending reviews first, then the message
				// is handed to the main agent as a kickoff; the handler itself
				// performs no other board or git action (FR-10 step 4).
				const result: MessageModeResult = await runMessageDev({
					cwd,
					message,
					kb: (a) => runKb(a, cwd),
					preFlight: () => preFlightCheck(cwd),
					spawnReviewer,
					sendUserMessage: (text) => pi.sendUserMessage(text),
					notify: (msg, level) => ctx.ui.notify(msg, level),
					setStatus: (status) => ctx.ui.setStatus("kb-dev", status),
				});
				report = result.report;
				delivered = result.delivered;
			} else {
				// Bare mode (FR-9): pending reviews first, then the next board-level
				// element via `kb next`, worked through its full cycle, then stop.
				const result: BareModeResult = await runBareDev({
					cwd,
					kb: (a) => runKb(a, cwd),
					spawnDev: async (task) =>
						runSubagent({ agent: "kb-developer", cwd, model: devModel, task: devTask(task, await storyOf(task)) }),
					spawnReviewer,
					notify: (msg, level) => ctx.ui.notify(msg, level),
					setStatus: (status) => ctx.ui.setStatus("kb-dev", status),
				});
				report = result.report;
			}
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
}
