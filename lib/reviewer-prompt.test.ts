import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const reviewerPrompt = fs.readFileSync(
	path.join(import.meta.dirname, "..", "agents", "kb-reviewer.md"),
	"utf8",
);

test("reviewer prompt reviews branch-vs-develop diff", () => {
	// The review target is the task branch diff against develop, not the working tree.
	assert.match(reviewerPrompt, /git diff develop(\.\.\.)?/i);
	assert.match(reviewerPrompt, /against `?develop`?/i);
	assert.match(reviewerPrompt, /not the working tree/i);
});

test("merge failure keeps item in review and reports the error", () => {
	assert.match(reviewerPrompt, /--ff-only/);
	assert.match(reviewerPrompt, /--no-ff/);
	assert.match(reviewerPrompt, /merge --abort/i);
	assert.match(reviewerPrompt, /stays? in `?review`?/i);
	assert.match(reviewerPrompt, /report(e|ing)? (the )?(failure|error)/i);
	// The reviewer must not move the item anywhere else after a failed merge.
	assert.match(reviewerPrompt, /do not move/i);
});

test("OK verdict merges and moves the item to done without deleting the branch", () => {
	assert.match(reviewerPrompt, /kb accept <ID> check/i);
	assert.match(reviewerPrompt, /kb move <ID> done/i);
	assert.match(reviewerPrompt, /never delete|do not delete/i);
	// Merge commit message references the task ID.
	assert.match(reviewerPrompt, /merge commit message referencing (the )?(task ID|<ID>)/i);
	// Problems verdict sends the item back to todo, branch stays open.
	assert.match(reviewerPrompt, /kb move <ID> todo/i);
	assert.match(reviewerPrompt, /branch (stays|remains|survives) open/i);
});
