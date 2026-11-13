/**
 * Subagent task prompts for the /kb-dev dispatch paths.
 *
 * Moved out of `index.ts` together with the dispatchers so the wiring in
 * `lib/dispatch.ts` is self-contained and `index.ts` only supplies the
 * seams (subagent runner, kb, config).
 */

import type { KbItem } from "./kb.ts";

export function devTask(task: KbItem, story?: KbItem | null): string {
	const where = story ? ` of story ${story.id} ("${story.title}")` : "";
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

export function reviewTask(item: KbItem): string {
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

export function qaTask(item: KbItem): string {
	return [
		`QA-review kanban item ${item.id} ("${item.title}"), currently in the "review" column, in the project rooted at the cwd.`,
		``,
		`Follow your system prompt (kb-qa) and the appended kb guide exactly:`,
		`- act as agent-qa-${item.id}`,
		`- run \`kb show ${item.id} --json\` and validate every acceptance criterion against the merged work on develop`,
		`- if OK: verify that every task branch of this ${item.type} (feature/<ID>, fix/<ID>) is merged into develop (tip is an ancestor of develop), delete the merged branches with \`git branch -d\`, check all acceptance criteria, add a note and move the item to done`,
		`- if problems: add a note listing them and move the item back to todo`,
		`- NEVER merge any branch yourself and never delete a branch with anything but \`git branch -d\``,
		``,
		`Finish with the verdict (OK / problems), the branches verified and deleted, and the final board status of ${item.id}.`,
	].join("\n");
}
