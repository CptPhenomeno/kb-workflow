import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const qaPrompt = fs.readFileSync(
	path.join(import.meta.dirname, "..", "agents", "kb-qa.md"),
	"utf8",
);

const indexSource = fs.readFileSync(
	path.join(import.meta.dirname, "..", "index.ts"),
	"utf8",
);

test("unmet criteria send the story back to todo with a note", () => {
	assert.match(qaPrompt, /agent-qa-<ID>/);
	assert.match(qaPrompt, /kb show <ID> --json/);
	assert.match(qaPrompt, /acceptance criteria/i);
	// on problems: note + move back to todo
	assert.match(qaPrompt, /kb note <ID>/);
	assert.match(qaPrompt, /kb move <ID> todo/);
	// on success: criteria checked, note, done
	assert.match(qaPrompt, /kb accept <ID> check/);
	assert.match(qaPrompt, /kb move <ID> done/);
});

test("kb-qa deletes only merged task branches with -d", () => {
	assert.match(qaPrompt, /feature\/<id>/);
	assert.match(qaPrompt, /fix\/<id>/);
	assert.match(qaPrompt, /ancestor of\s+`?develop`?/);
	assert.match(qaPrompt, /git branch -d/);
	// -D is explicitly forbidden, never used as an instruction
	assert.match(qaPrompt, /[Nn]ever use `?git branch -D`?/);
	assert.doesNotMatch(qaPrompt, /git branch -D <branch>/);
	assert.match(qaPrompt, /never merge/i);
	assert.match(qaPrompt, /never push/i);
	assert.match(qaPrompt, /no remote/i);
});

test("kb_agent tool accepts agent \"kb-qa\"", () => {
	assert.match(indexSource, /StringEnum\(\["kb-planner", "kb-developer", "kb-reviewer", "kb-qa"\]/);
	assert.match(indexSource, /kb_agent[\s\S]*?kb-qa|kb-qa[\s\S]*?kb_agent/);
	// the tool description mentions kb-qa (string literals are concatenated across lines)
	const flat = indexSource.replace(/"\s*\+?\s*\n\s*"/g, "").replace(/\s+/g, " ");
	assert.match(flat, /description:.*kb-qa to review a story or epic in the review column/);
});
