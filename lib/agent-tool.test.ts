import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { executeKbAgent, kbAgentToolResult } from "./agent-tool.ts";
import type { KbWorkflowConfig } from "./config.ts";
import type { KbAgentName, SubagentResult, SubagentUsage } from "./subagent.ts";

function config(partial: KbWorkflowConfig): KbWorkflowConfig {
	return partial;
}

function result(agent: KbAgentName, opts: { model?: string; thinkingLevel?: string }): SubagentResult {
	return {
		ok: true,
		agent,
		actor: "agent-test",
		output: `ran ${agent} model=${opts.model ?? "-"} thinking=${opts.thinkingLevel ?? "-"}`,
		stderr: "",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
	};
}

test("kb_agent tool resolves and forwards model and thinking-level per role", async () => {
	const seen: Array<{ agent: KbAgentName; model?: string; thinkingLevel?: string }> = [];
	await executeKbAgent({
		agent: "kb-developer",
		task: "implement KB-8",
		config: config({
			kbAgents: {
				developer: { model: "provider/dev", thinkingLevel: "high" },
			},
		}),
		session: { model: "provider/session", thinkingLevel: "medium" },
		runSubagent: async (opts) => {
			seen.push({ agent: opts.agent, model: opts.model, thinkingLevel: opts.thinkingLevel });
			return result(opts.agent, opts);
		},
	});
	assert.deepEqual(seen, [
		{ agent: "kb-developer", model: "provider/dev", thinkingLevel: "high" },
	]);
});

function roundUsage(): SubagentUsage {
	return { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100, cost: 0.42, turns: 3 };
}

function subagentResult(agent: KbAgentName): SubagentResult {
	return {
		ok: true,
		agent,
		actor: "agent-test",
		output: `ran ${agent}`,
		stderr: "",
		exitCode: 0,
		usage: roundUsage(),
	};
}

/**
 * pi accounts a tool's spend from the `usage` field of its result: tool
 * results are persisted as `toolResult` messages and `getUsageCostBreakdown`
 * (pi-coding-agent `dist/core/usage-totals.js`) sums their `usage` into the
 * "Tools/summaries" bucket, reading `usage.cost.total`. Resolved from the
 * installed pi release when present; a faithful local port of that function
 * otherwise, so the suite also runs without a pi install.
 */
async function piUsageCostBreakdown(): Promise<
	(entries: Array<{ type: string; message?: { role: string; usage?: unknown } }>) => Array<{ key: string; cost: number; tokens: number }>
> {
	const roots = [process.env.PI_MANAGED_INSTALL_ROOT, path.join(os.homedir(), ".pi", "agent", "install")].filter(
		(root): root is string => typeof root === "string" && root !== "",
	);
	for (const root of roots) {
		let versions: string[] = [];
		try {
			versions = fs.readdirSync(path.join(root, "releases")).sort().reverse();
		} catch {
			continue;
		}
		for (const version of versions) {
			const modulePath = path.join(
				root,
				"releases",
				version,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"dist",
				"core",
				"usage-totals.js",
			);
			if (!fs.existsSync(modulePath)) continue;
			const mod: { getUsageCostBreakdown?: unknown } = await import(modulePath);
			if (typeof mod.getUsageCostBreakdown === "function") return mod.getUsageCostBreakdown as any;
		}
	}
	// Faithful port of pi's getUsageCostBreakdown, toolResult branch only.
	return (entries) => {
		const totals = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message?.role !== "toolResult" || !entry.message.usage) continue;
			const usage = entry.message.usage as Record<string, any>;
			const t = totals.get("Tools/summaries") ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			t.input += usage.input ?? 0;
			t.output += usage.output ?? 0;
			t.cacheRead += usage.cacheRead ?? 0;
			t.cacheWrite += usage.cacheWrite ?? 0;
			t.cost += usage.cost?.total ?? 0;
			totals.set("Tools/summaries", t);
		}
		return Array.from(totals, ([key, t]) => ({
			key,
			cost: t.cost,
			tokens: t.input + t.output + t.cacheRead + t.cacheWrite,
		}));
	};
}

test("kb_agent tool result carries the round usage in the field pi accounts for", () => {
	const toolResult = kbAgentToolResult(subagentResult("kb-reviewer"));
	// pi's `Usage` shape (pi-ai): cost is the cost object pi expects, with
	// `total` — not the flat number of the internal SubagentUsage (FR-31).
	assert.deepEqual(toolResult.usage, {
		input: 1000,
		output: 500,
		cacheRead: 2000,
		cacheWrite: 100,
		totalTokens: 3600,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 },
	});
});

test("pi's session totals include the kb_agent subagent spend", async () => {
	const toolResult = kbAgentToolResult(subagentResult("kb-developer"));
	// pi persists the tool result as a toolResult message entry and accounts
	// its `usage` in the session totals (footer, /session, FR-31).
	const entries = [{ type: "message", message: { role: "toolResult", usage: toolResult.usage } }];
	const breakdown = await piUsageCostBreakdown();
	const bucket = breakdown(entries).find((b) => b.key === "Tools/summaries");
	assert.ok(bucket, "no Tools/summaries bucket in the session totals");
	assert.equal(bucket.cost, 0.42);
	assert.equal(bucket.tokens, 3600);
});

test("details still carry usage for the rendering", () => {
	const res = subagentResult("kb-qa");
	const toolResult = kbAgentToolResult(res);
	// `details.usage` keeps the internal flat SubagentUsage (with `turns`),
	// unchanged for the custom rendering (FR-31).
	assert.deepEqual(toolResult.details, {
		ok: res.ok,
		agent: res.agent,
		actor: res.actor,
		exitCode: res.exitCode,
		usage: roundUsage(),
	});
});

test("kb_agent tool streams resolved model and thinking level in the tool-call details", async () => {
	// FR-23: while the subagent runs, every streamed update's `details`
	// carries the resolved config — `{ agent, running, model, thinkingLevel }`
	// — so even the default rendering shows what the round runs with.
	const updates: Array<any> = [];
	await executeKbAgent({
		agent: "kb-developer",
		task: "implement KB-48",
		config: config({
			kbAgents: {
				developer: { model: "provider/dev", thinkingLevel: "high" },
			},
		}),
		session: { model: "provider/session", thinkingLevel: "medium" },
		onUpdate: (update) => updates.push(update),
		runSubagent: async (opts) => {
			opts.onUpdate?.("working…");
			return result(opts.agent, opts);
		},
	});
	assert.equal(updates.length, 1);
	assert.deepEqual(updates[0].details, {
		agent: "kb-developer",
		running: true,
		model: "provider/dev",
		thinkingLevel: "high",
	});
});

test("the onUpdate text carries the resolved model and thinking level of the running round", async () => {
	// FR-23: the streamed text carries them too — the running line of the
	// prototype's running call (variant A): `<agent> running · <model> ·
	// thinking <level>`, followed by the streamed subagent text.
	const texts: string[] = [];
	await executeKbAgent({
		agent: "kb-developer",
		task: "implement KB-48",
		config: config({
			kbAgents: {
				developer: { model: "provider/dev", thinkingLevel: "high" },
			},
		}),
		session: { model: "provider/session", thinkingLevel: "medium" },
		onUpdate: (update) => texts.push(update.content[0].text),
		runSubagent: async (opts) => {
			opts.onUpdate?.("working…");
			return result(opts.agent, opts);
		},
	});
	assert.equal(texts.length, 1);
	assert.match(texts[0], /^kb-developer running · provider\/dev · thinking high\nworking…$/);
});

test("details carry model and thinkingLevel on every update, not only the first", async () => {
	// FR-23: "every onUpdate" — the resolved config rides on each partial
	// result, so a rendering rebuilt from any update shows it.
	const updates: Array<any> = [];
	await executeKbAgent({
		agent: "kb-reviewer",
		task: "review KB-48",
		config: config({
			kbAgents: {
				reviewer: { model: "provider/rev", thinkingLevel: "low" },
			},
		}),
		session: { model: "provider/session", thinkingLevel: "medium" },
		onUpdate: (update) => updates.push(update),
		runSubagent: async (opts) => {
			opts.onUpdate?.("first");
			opts.onUpdate?.("second");
			opts.onUpdate?.("third");
			return result(opts.agent, opts);
		},
	});
	assert.equal(updates.length, 3);
	for (const update of updates) {
		assert.deepEqual(update.details, {
			agent: "kb-reviewer",
			running: true,
			model: "provider/rev",
			thinkingLevel: "low",
		});
	}
});

test("a role absent from the config streams the session model and thinking level", async () => {
	// FR-20/FR-23: the streamed values are the resolved ones — a role with
	// no config entry falls back to the dispatching session's model and
	// thinking level, never to a raw (undefined) config entry.
	const updates: Array<any> = [];
	await executeKbAgent({
		agent: "kb-qa",
		task: "qa KB-47",
		config: config({
			kbAgents: {
				developer: { model: "provider/dev", thinkingLevel: "high" },
			},
		}),
		session: { model: "provider/session", thinkingLevel: "medium" },
		onUpdate: (update) => updates.push(update),
		runSubagent: async (opts) => {
			opts.onUpdate?.("working…");
			return result(opts.agent, opts);
		},
	});
	assert.equal(updates.length, 1);
	assert.deepEqual(updates[0].details, {
		agent: "kb-qa",
		running: true,
		model: "provider/session",
		thinkingLevel: "medium",
	});
	assert.match(updates[0].content[0].text, /^kb-qa running · provider\/session · thinking medium/);
});

test("kb_agent tool forwards the resolved model and thinking level", async () => {
	// Unset properties fall back independently to the session's values.
	const seen: Array<{ model?: string; thinkingLevel?: string }> = [];
	await executeKbAgent({
		agent: "kb-reviewer",
		task: "review KB-8",
		config: config({ kbAgents: { reviewer: { model: "provider/rev" } } }),
		session: { model: "provider/session", thinkingLevel: "low" },
		runSubagent: async (opts) => {
			seen.push({ model: opts.model, thinkingLevel: opts.thinkingLevel });
			return result(opts.agent, opts);
		},
	});
	assert.deepEqual(seen, [{ model: "provider/rev", thinkingLevel: "low" }]);
});
