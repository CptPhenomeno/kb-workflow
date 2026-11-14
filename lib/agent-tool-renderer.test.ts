/**
 * Tests for the kb_agent custom rendering (FR-24 / AC-31, KB-49): the
 * validated prototype's variant A — the resolved model and thinking level
 * inline on the tool-call title line, the last streamed line while
 * running, and the `✓ completed` line plus the variant A usage line
 * (duration, tokens in/out, cache r/w, cost, turns) when finished.
 *
 * The renderers are pure functions over (args/result, theme, context);
 * the tests drive them with a recording fake theme (which theme tokens are
 * used) and a minimal render context, the way pi's ToolExecutionComponent
 * would. The tool-call shell (the state-tinted Box) is pi's own — the
 * renderers must not draw any framing themselves.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Box, Text } from "@earendil-works/pi-tui";
import { executeKbAgent, kbAgentToolResult } from "./agent-tool.ts";
import { kbAgentRenderCall, kbAgentRenderResult } from "./agent-tool-renderer.ts";
import type { KbWorkflowConfig } from "./config.ts";
import type { KbAgentName, SubagentResult, SubagentUsage } from "./subagent.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexTs = fs.readFileSync(path.join(root, "index.ts"), "utf8");
/** The kb_agent tool registration block of index.ts. */
const kbAgentBlock = indexTs.slice(indexTs.indexOf('name: "kb_agent"'), indexTs.indexOf('pi.registerCommand("kb-plan"'));

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A fake pi theme that records which tokens style which text. */
function recordingTheme() {
	const fgCalls: Array<{ token: string; text: string }> = [];
	const bgCalls: Array<{ token: string; text: string }> = [];
	const theme = {
		fg: (token: string, text: string) => {
			fgCalls.push({ token, text });
			return text;
		},
		bg: (token: string, text: string) => {
			bgCalls.push({ token, text });
			return text;
		},
		bold: (text: string) => text,
	};
	return { theme, fgCalls, bgCalls };
}

/** A minimal ToolRenderContext: shared row state, invalidate counter, key hints. */
function renderContext(overrides: Record<string, unknown> = {}) {
	const state: Record<string, unknown> = {};
	let invalidations = 0;
	const context = {
		args: { agent: "kb-developer", task: "implement KB-49" },
		toolCallId: "tc-1",
		invalidate: () => {
			invalidations++;
		},
		lastComponent: undefined,
		state,
		cwd: "/tmp/project",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined as number | undefined,
		outputPad: 1,
		keyHint: (_keybinding: string, description: string) => `e ${description}`,
		keyText: () => "e",
		...overrides,
	};
	return { context, state, invalidations: () => invalidations };
}

/** The tool result pi hands the renderer: content + the kb_agent details. */
function toolResult(details: Record<string, unknown>, contentText = "model-facing text") {
	return { content: [{ type: "text" as const, text: contentText }], details };
}

function roundUsage(): SubagentUsage {
	return { input: 45230, output: 3120, cacheRead: 184000, cacheWrite: 12000, cost: 0.89, turns: 6 };
}

function subagentResult(agent: KbAgentName, usage: SubagentUsage = roundUsage()): SubagentResult {
	return { ok: true, agent, actor: "agent-test", output: "ran", stderr: "", exitCode: 0, usage };
}

// ---------------------------------------------------------------------------
// renderCall — the title line (variant A)
// ---------------------------------------------------------------------------

test("renderCall puts the resolved model and thinking level inline on the tool-call title line", () => {
	const { theme, fgCalls } = recordingTheme();

	// The live flow: the partial renderResult stashes the resolved config
	// in the shared row state (and invalidates the row), then the call slot
	// renders the title line with the config inline.
	const { context, state, invalidations } = renderContext({ isPartial: true });
	const partial = toolResult({ agent: "kb-developer", running: true, model: "anthropic/claude-sonnet-4.5", thinkingLevel: "high" });
	kbAgentRenderResult(partial, { expanded: false, isPartial: true }, theme, context);
	assert.equal(state.model, "anthropic/claude-sonnet-4.5");
	assert.equal(state.thinkingLevel, "high");
	assert.equal(invalidations(), 1, "the row is invalidated once, when the config arrives");

	const call = kbAgentRenderCall({ agent: "kb-developer", task: "implement KB-49" }, theme, context);
	assert.ok(call instanceof Text, "renderCall returns a Text component");
	assert.equal(
		call.text,
		"kb_agent kb-developer [anthropic/claude-sonnet-4.5 · thinking high]",
		"variant A: model and thinking level inline on the title line",
	);
	// The prototype's styling: toolTitle on the name, toolOutput on the
	// model, muted brackets and separator.
	assert.deepEqual(
		fgCalls.filter((c) => c.text === "kb_agent kb-developer").map((c) => c.token),
		["toolTitle"],
	);
	assert.deepEqual(
		fgCalls.filter((c) => c.text === "anthropic/claude-sonnet-4.5").map((c) => c.token),
		["toolOutput"],
	);
	assert.ok(fgCalls.some((c) => c.token === "muted" && c.text === "["));
	assert.ok(fgCalls.some((c) => c.token === "muted" && c.text === "·"));
	assert.ok(fgCalls.some((c) => c.token === "muted" && c.text === "]"));
});

test("renderCall shows the bare title before the first update carries the config", () => {
	const { theme } = recordingTheme();
	const { context } = renderContext();
	const call = kbAgentRenderCall({ agent: "kb-reviewer", task: "review KB-49" }, theme, context);
	assert.equal(call.text, "kb_agent kb-reviewer");
});

test("the thinking badge uses the theme's per-level thinking token", () => {
	const levels: Array<[string, string]> = [
		["off", "thinkingOff"],
		["minimal", "thinkingMinimal"],
		["low", "thinkingLow"],
		["medium", "thinkingMedium"],
		["high", "thinkingHigh"],
		["xhigh", "thinkingXhigh"],
		["max", "thinkingMax"],
	];
	for (const [level, token] of levels) {
		const { theme, fgCalls } = recordingTheme();
		const { context } = renderContext();
		context.state.model = "provider/m";
		context.state.thinkingLevel = level;
		const call = kbAgentRenderCall({ agent: "kb-developer", task: "t" }, theme, context);
		assert.equal(call.text, `kb_agent kb-developer [provider/m · thinking ${level}]`);
		assert.deepEqual(
			fgCalls.filter((c) => c.text === `thinking ${level}`).map((c) => c.token),
			[token],
			`level ${level} styles with the theme's ${token} token`,
		);
	}
	// An unknown level falls back to muted (the theme has no token for it).
	const { theme, fgCalls } = recordingTheme();
	const { context } = renderContext();
	context.state.thinkingLevel = "ultra";
	const call = kbAgentRenderCall({ agent: "kb-developer", task: "t" }, theme, context);
	assert.equal(call.text, "kb_agent kb-developer [thinking ultra]");
	assert.deepEqual(
		fgCalls.filter((c) => c.text === "thinking ultra").map((c) => c.token),
		["muted"],
	);
});

// ---------------------------------------------------------------------------
// renderResult — running, then completed with the variant A usage line
// ---------------------------------------------------------------------------

test("renderResult shows the completed line with the variant A usage line (duration, tokens, cache, cost, turns)", () => {
	const { theme, fgCalls } = recordingTheme();
	const res = subagentResult("kb-developer");
	const result = kbAgentToolResult(res, {
		resolved: { model: "anthropic/claude-sonnet-4.5", thinkingLevel: "high" },
		lines: ["branch feature/KB-49 created from develop"],
	});
	const { context } = renderContext({ durationMs: 42300 });
	const component = kbAgentRenderResult(result, { expanded: false, isPartial: false }, theme, context);

	assert.ok(component instanceof Text);
	const [completed, ...rest] = component.text.split("\n");
	assert.equal(
		completed,
		"✓ completed ⏱ 42.3s · 45k in / 3k out · cache 184kr/12kw · €0.89 · 6 turns",
		"the variant A usage line: duration, tokens in/out, cache r/w, cost, turns",
	);
	assert.deepEqual(
		fgCalls.filter((c) => c.text === "✓ completed").map((c) => c.token),
		["success"],
	);
	assert.ok(
		fgCalls.some((c) => c.token === "muted" && c.text.includes("⏱ 42.3s")),
		"the usage line is muted",
	);
	// The single streamed line is shown even collapsed (≤ 2 lines).
	assert.ok(rest.some((line) => line === "branch feature/KB-49 created from develop"));
});

test("renderResult running shows the last streamed line and stashes the resolved config once", () => {
	const { theme } = recordingTheme();
	const { context, invalidations } = renderContext({ isPartial: true });
	const partial = toolResult(
		{ agent: "kb-developer", running: true, model: "provider/dev", thinkingLevel: "high" },
		"kb-developer running · provider/dev · thinking high\nediting lib/agent-tool.ts",
	);
	const first = kbAgentRenderResult(partial, { expanded: false, isPartial: true }, theme, context);
	assert.ok(first instanceof Text);
	assert.equal(first.text, "… editing lib/agent-tool.ts", "while running, the last streamed line is shown");
	assert.equal(invalidations(), 1);
	// A repeated partial with the same config does not invalidate again.
	kbAgentRenderResult(partial, { expanded: false, isPartial: true }, theme, context);
	assert.equal(invalidations(), 1, "the config is stashed and the row invalidated only when it changes");
});

test("a failed round renders a failed line, not a completed one", () => {
	const { theme } = recordingTheme();
	const res = subagentResult("kb-developer");
	res.ok = false;
	res.exitCode = 1;
	const result = kbAgentToolResult(res);
	const { context } = renderContext({ durationMs: 1000 });
	const component = kbAgentRenderResult(result, { expanded: false, isPartial: false }, theme, context);
	assert.ok(component.text.startsWith("✗ failed (exit 1)"), component.text);
});

// ---------------------------------------------------------------------------
// Framing — pi's ToolExecutionComponent provides the box
// ---------------------------------------------------------------------------

test("the renderer draws no framing of its own because pi's ToolExecutionComponent provides the box", () => {
	const { theme } = recordingTheme();
	const { context } = renderContext({ durationMs: 42300 });
	const result = kbAgentToolResult(subagentResult("kb-developer"), {
		resolved: { model: "provider/m", thinkingLevel: "high" },
		lines: ["one", "two", "three"],
	});

	const call = kbAgentRenderCall({ agent: "kb-developer", task: "t" }, theme, context);
	const done = kbAgentRenderResult(result, { expanded: false, isPartial: false }, theme, context);

	// No Box, no Spacer, no background: both slots return a bare Text with
	// zero padding — the state-tinted Box (toolPendingBg/toolSuccessBg) is
	// drawn by pi's ToolExecutionComponent around whatever they return.
	for (const component of [call, done]) {
		assert.ok(component instanceof Text, "the slot returns a Text, not a Box");
		assert.ok(!(component instanceof Box), "the renderer must not draw its own box");
		assert.equal(component.paddingX, 0, "no horizontal padding of its own");
		assert.equal(component.paddingY, 0, "no vertical padding or spacer of its own");
		assert.equal(component.customBgFn, undefined, "no background of its own");
		const lines = component.render(80);
		for (const line of lines) {
			assert.ok(!/[─│┌┐└┘]/.test(line), `no border characters: ${JSON.stringify(line)}`);
			// No padding of its own: the only leading spaces are the content
			// indent of the muted collapse hint (two, as in the prototype).
			assert.ok(!/^ {3}/.test(line), `no leading padding — the Box provides it: ${JSON.stringify(line)}`);
		}
	}
});

// ---------------------------------------------------------------------------
// Expanded vs collapsed stream lines
// ---------------------------------------------------------------------------

test("an expanded result shows every streamed line, a collapsed one the last two", () => {
	const { theme, fgCalls } = recordingTheme();
	const lines = [
		"branch feature/KB-49 created from develop",
		"editing lib/agent-tool.ts (resolved config in onUpdate)",
		"editing index.ts (renderCall/renderResult)",
		"tests: lib/agent-tool-renderer.test.ts — 12 passing",
		"commit 8f3ac21 on feature/KB-49",
	];
	const result = kbAgentToolResult(subagentResult("kb-developer"), {
		resolved: { model: "anthropic/claude-sonnet-4.5", thinkingLevel: "high" },
		lines,
	});
	const { context } = renderContext({ durationMs: 42300 });

	const expanded = kbAgentRenderResult(result, { expanded: true, isPartial: false }, theme, context);
	for (const line of lines) {
		assert.ok(expanded.text.split("\n").includes(line), `expanded shows "${line}"`);
	}
	assert.ok(!expanded.text.includes("more lines"), "no collapse hint when expanded");

	const collapsed = kbAgentRenderResult(result, { expanded: false, isPartial: false }, theme, context);
	const collapsedLines = collapsed.text.split("\n");
	assert.ok(!collapsedLines.includes(lines[0]), "the first streamed line is hidden when collapsed");
	assert.ok(collapsedLines.includes(lines[3]), "collapsed shows the second-to-last line");
	assert.ok(collapsedLines.includes(lines[4]), "collapsed shows the last line");
	assert.ok(
		collapsedLines.some((l) => l.includes("… (3 more lines, e to expand)")),
		"collapsed counts the hidden lines and hints the expand key",
	);
	// The streamed lines are styled toolOutput, the hint muted.
	const toolOutputTexts = fgCalls.filter((c) => c.token === "toolOutput").map((c) => c.text);
	assert.ok(toolOutputTexts.includes(lines[4]));
	assert.ok(fgCalls.some((c) => c.token === "muted" && c.text.includes("3 more lines")));
});

// ---------------------------------------------------------------------------
// The seams that feed the rendering: details carry the resolved config and
// the streamed lines; executeKbAgent returns them (FR-24).
// ---------------------------------------------------------------------------

test("the final tool result details carry the resolved config and the streamed lines for the rendering", () => {
	const res = subagentResult("kb-developer");
	const result = kbAgentToolResult(res, {
		resolved: { model: "anthropic/claude-sonnet-4.5", thinkingLevel: "high" },
		lines: ["first", "second"],
	});
	// The final render (and a reload) reads the config and the stream from
	// the persisted details — not from the live row state.
	assert.equal(result.details.model, "anthropic/claude-sonnet-4.5");
	assert.equal(result.details.thinkingLevel, "high");
	assert.deepEqual(result.details.lines, ["first", "second"]);
	// The model-facing content and pi's usage accounting are unchanged.
	assert.ok(result.content[0].text.startsWith("Subagent kb-developer completed."));
	assert.equal(result.usage.cost.total, 0.89);
});

test("executeKbAgent returns the resolved config and every streamed line of the round", async () => {
	const execution = await executeKbAgent({
		agent: "kb-developer",
		task: "implement KB-49",
		config: { kbAgents: { developer: { model: "provider/dev", thinkingLevel: "high" } } } as KbWorkflowConfig,
		session: { model: "provider/session", thinkingLevel: "medium" },
		runSubagent: async (opts) => {
			opts.onUpdate?.("first");
			opts.onUpdate?.("second");
			return subagentResult(opts.agent);
		},
	});
	assert.deepEqual(execution.resolved, { model: "provider/dev", thinkingLevel: "high" });
	assert.deepEqual(execution.lines, ["first", "second"], "the streamed assistant texts, in order");
	assert.equal(execution.result.agent, "kb-developer");
});

test("index.ts registers the custom renderers on the kb_agent tool", () => {
	// FR-24: the kb_agent tool registration carries renderCall/renderResult
	// from the shared lib module — the TUI uses them for the tool row.
	assert.ok(indexTs.includes('from "./lib/agent-tool-renderer.ts"'), "the renderers live in lib/");
	assert.ok(kbAgentBlock.includes("renderCall: kbAgentRenderCall"), "the tool registers renderCall");
	assert.ok(kbAgentBlock.includes("renderResult: kbAgentRenderResult"), "the tool registers renderResult");
	// The tool passes the round's resolved config and streamed lines into
	// the final result so the rendering survives a reload.
	assert.ok(kbAgentBlock.includes("kbAgentToolResult("), "the tool builds its result through the seam");
});
