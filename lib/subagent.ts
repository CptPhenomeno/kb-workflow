/**
 * Spawns kb subagents as isolated `pi` processes.
 *
 * Each subagent runs `pi --mode json -p --no-session --append-system-prompt <tmp>`
 * where the system prompt file is the agent definition in `agents/<name>.md`
 * followed by the output of `kb guide`. stdout is parsed as JSON Lines
 * (`message_end` events) to extract the final assistant text and usage.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runKb } from "./kb.ts";

export type KbAgentName = "kb-planner" | "kb-developer" | "kb-reviewer";

export const KB_AGENT_NAMES: readonly KbAgentName[] = ["kb-planner", "kb-developer", "kb-reviewer"];

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(LIB_DIR, "..", "agents");

/** Board actor name used by each agent (see `kb guide`: agent-<topic>). */
export function actorForAgent(agent: KbAgentName): string {
	switch (agent) {
		case "kb-planner":
			return "agent-plan";
		case "kb-developer":
			return "agent-dev";
		case "kb-reviewer":
			return "agent-review";
	}
}

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface SubagentResult {
	ok: boolean;
	agent: KbAgentName;
	actor: string;
	/** Last assistant text message produced by the subagent. */
	output: string;
	stderr: string;
	exitCode: number | null;
	stopReason?: string;
	errorMessage?: string;
	usage: SubagentUsage;
}

export interface RunSubagentOptions {
	agent: KbAgentName;
	task: string;
	cwd: string;
	/** `provider/model` string; when omitted the subagent inherits the dispatching session's model. */
	model?: string;
	/** Thinking level of the dispatching session; only forwarded when inheriting the model. */
	thinkingLevel?: string;
	signal?: AbortSignal;
	/** Called with the latest assistant text on every streamed message. */
	onUpdate?: (text: string) => void;
}

interface ProcessOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	spawnError?: Error;
}

/** Same logic as the upstream subagent example: run the current pi binary when possible. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

function lastAssistantText(messages: Array<{ role: string; content: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		if (Array.isArray(msg.content)) {
			const texts = msg.content
				.filter((p): p is { type: "text"; text: string } => typeof p === "object" && p !== null && (p as any).type === "text")
				.map((p) => p.text);
			if (texts.length > 0) return texts.join("\n");
		}
	}
	return "";
}

export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
	const actor = actorForAgent(opts.agent);
	const usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	const result: SubagentResult = {
		ok: false,
		agent: opts.agent,
		actor,
		output: "",
		stderr: "",
		exitCode: null,
		usage,
	};

	// Build the system prompt: agent definition + the kb agent guide.
	const agentPrompt = fs.readFileSync(path.join(AGENTS_DIR, `${opts.agent}.md`), "utf8");
	const guide = await runKb(["guide"], opts.cwd, { json: false });
	const systemPrompt = `${agentPrompt}\n\n---\n\n# kb agent guide (output of \`kb guide\`)\n\n${guide.stdout}`;

	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-kb-agent-"));
	const tmpFile = path.join(tmpDir, "system-prompt.md");
	await fs.promises.writeFile(tmpFile, systemPrompt, { encoding: "utf8", mode: 0o600 });

	const args = ["--mode", "json", "-p", "--no-session"];
	if (opts.model) args.push("--model", opts.model);
	else if (opts.thinkingLevel) args.push("--thinking", opts.thinkingLevel);
	args.push("--append-system-prompt", tmpFile);
	args.push(`Task:\n${opts.task}`);

	try {
		const invocation = getPiInvocation(args);
		const outcome = await new Promise<ProcessOutcome>((resolve) => {
			const messages: Array<{ role: string; content: unknown }> = [];
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let buffer = "";

			const finish = (o: ProcessOutcome) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				if (opts.signal) opts.signal.removeEventListener("abort", abortProcess);
				resolve(o);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event?.type !== "message_end") return;
				const m = event.message;
				if (!m || (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult")) return;
				messages.push(m);
				if (m.role === "assistant") {
					usage.turns++;
					usage.input += m.usage?.input ?? 0;
					usage.output += m.usage?.output ?? 0;
					usage.cacheRead += m.usage?.cacheRead ?? 0;
					usage.cacheWrite += m.usage?.cacheWrite ?? 0;
					usage.cost += m.usage?.cost?.total ?? 0;
					result.stopReason = m.stopReason;
					result.errorMessage = m.errorMessage;
					const text = lastAssistantText(messages);
					if (text) {
						result.output = text;
						opts.onUpdate?.(text);
					}
				}
			};

			let proc: ReturnType<typeof spawn>;
			const abortProcess = () => {
				if (settled || proc.exitCode !== null || proc.signalCode !== null) return;
				if (!proc.kill("SIGTERM")) return;
				killTimer = setTimeout(() => {
					if (!settled && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
				}, 5000);
			};

			try {
				proc = spawn(invocation.command, invocation.args, {
					cwd: opts.cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, KB_ACTOR: actor },
				});
			} catch (error) {
				finish({ code: null, signal: null, spawnError: error instanceof Error ? error : new Error(String(error)) });
				return;
			}

			proc.stdout?.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr?.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code, signal) => {
				if (buffer.trim()) processLine(buffer);
				finish({ code, signal });
			});
			proc.on("error", (error) => finish({ code: null, signal: null, spawnError: error }));

			if (opts.signal) {
				if (opts.signal.aborted) abortProcess();
				else opts.signal.addEventListener("abort", abortProcess, { once: true });
			}
		});

		result.exitCode = outcome.code;
		if (outcome.spawnError) {
			result.errorMessage = `Failed to spawn subagent: ${outcome.spawnError.message}`;
		} else if (outcome.signal) {
			result.errorMessage = `Subagent terminated by signal ${outcome.signal}`;
		} else if (outcome.code !== 0) {
			result.errorMessage = `Subagent exited with code ${outcome.code}`;
		} else if (result.stopReason === "error") {
			// errorMessage already set from the assistant message
		}
		result.ok = outcome.code === 0 && !outcome.signal && !outcome.spawnError && result.stopReason !== "error" && result.stopReason !== "aborted";
		if (!result.output) result.output = "(no output)";
		return result;
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}
