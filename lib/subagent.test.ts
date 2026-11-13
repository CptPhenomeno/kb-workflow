import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPiArgs } from "./subagent.ts";

test("role with explicit model receives both --model <configured> and --thinking <session level>", () => {
	const args = buildPiArgs({ model: "provider/configured", thinkingLevel: "high" });
	assert.ok(args.includes("--model"));
	assert.equal(args[args.indexOf("--model") + 1], "provider/configured");
	assert.ok(args.includes("--thinking"));
	assert.equal(args[args.indexOf("--thinking") + 1], "high");
});

test("absent role inherits the session model and thinking level", () => {
	const args = buildPiArgs({ model: "provider/session", thinkingLevel: "medium" });
	assert.equal(args[args.indexOf("--model") + 1], "provider/session");
	assert.equal(args[args.indexOf("--thinking") + 1], "medium");
});

test("configured thinking-level is passed as --thinking without a --model", () => {
	const args = buildPiArgs({ thinkingLevel: "low" });
	assert.ok(!args.includes("--model"));
	assert.equal(args[args.indexOf("--thinking") + 1], "low");
});

test("neither property set passes neither flag", () => {
	const args = buildPiArgs({});
	assert.ok(!args.includes("--model"));
	assert.ok(!args.includes("--thinking"));
});
