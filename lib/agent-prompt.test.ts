import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const developerPrompt = fs.readFileSync(
	path.join(import.meta.dirname, "..", "agents", "kb-developer.md"),
	"utf8",
);

test("kb-developer prompt forbids push and committing on develop", () => {
	assert.ok(
		!developerPrompt.includes("Do not commit or push unless explicitly asked"),
		"the old rule must be gone",
	);
	assert.match(developerPrompt, /never push/i);
	assert.match(developerPrompt, /never commit on `?develop`?/i);
	assert.match(developerPrompt, /commit autonomously/i);
});

test("kb-developer prompt requires conventional commit messages", () => {
	assert.match(developerPrompt, /conventional commit/i);
	assert.match(developerPrompt, /feat\(kb-XX\)/);
	assert.match(developerPrompt, /fix\(kb-XX\)/);
	assert.match(developerPrompt, /docs\(kb-XX\)/);
	assert.match(developerPrompt, /kanban item ID as the scope/i);
	assert.match(developerPrompt, /imperative/i);
});

test("kb-developer prompt requires clean tree before moving to review", () => {
	assert.match(developerPrompt, /clean working tree/i);
	assert.match(developerPrompt, /before `?kb move (<ID>|<id>) review`?/i);
});
