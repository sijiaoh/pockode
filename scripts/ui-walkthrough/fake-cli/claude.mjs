// A stand-in for the `claude` CLI, put first on the walkthrough server's PATH
// (through the `claude` wrapper beside it) so that an agent's turn is something
// that happens on demand, the same way every run, and costs nothing.
//
// It speaks just enough stream-json for Pockode to run a turn. Every Pockode
// tool it calls goes through the real path: the call goes to the server's
// local MCP API with this process's own session identity, exactly what the
// stdio proxy would send, so the transcript gets the tool row, and the work
// store and the session's unanswered list get what a real agent's call would
// leave in them.
//
// What it does is picked by the prompt:
//   - a prompt containing a chat or marketing scenario's `prompt` plays that
//     scenario's turn (../chat/scenarios.mjs, ../marketing/scenarios.mjs) —
//     "containing", because a message with attachments reaches the CLI with
//     their paths beside the text, an answer with its question, and a work's
//     every message with the work's title;
//   - a prompt that is exactly a question scenario's `prompt` asks that
//     scenario (../question/scenarios.mjs);
//   - any other work's kickoff prompt ("(Work ID: ...") asks scenario "work";
//   - anything else, answers to a question no scenario plays included, is
//     acknowledged in one line.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { CHAT } from "../chat/scenarios.mjs";
import { MARKETING } from "../marketing/scenarios.mjs";
import { SCENARIOS } from "../question/scenarios.mjs";

const args = process.argv.slice(2);

if (args.includes("--version")) {
	console.log("2.1.300 (Claude Code)");
	process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
	console.log(
		JSON.stringify({
			loggedIn: true,
			authMethod: "claude.ai",
			email: "walkthrough@example.com",
		}),
	);
	process.exit(0);
}
if (!args.includes("--input-format")) {
	console.error(`fake claude: unsupported invocation: ${args.join(" ")}`);
	process.exit(1);
}

function argValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

const cliSessionId =
	argValue("--session-id") ?? argValue("--resume") ?? randomUUID();

// A flag the stdio proxy would have been spawned with, read back out of the
// MCP config Pockode wrote for this process.
function proxyFlag(name) {
	const configPath = argValue("--mcp-config");
	if (!configPath) throw new Error("no --mcp-config: Pockode tools disabled");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const proxyArgs = config.mcpServers.pockode.args;
	const i = proxyArgs.indexOf(name);
	return i >= 0 ? proxyArgs[i + 1] : undefined;
}

// The identity the stdio proxy would have been spawned with.
function mcpCaller() {
	const info = JSON.parse(
		readFileSync(join(proxyFlag("--data-dir"), "server.json"), "utf8"),
	);
	return {
		url: `${info.local_url || `http://localhost:${info.port}`}/api/mcp/tools/call`,
		token: info.token,
		caller: {
			session_id: proxyFlag("--session-id"),
			worktree: proxyFlag("--worktree"),
		},
	};
}

async function callTool(name, toolArgs) {
	const { url, token, caller } = mcpCaller();
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ name, arguments: toolArgs, caller }),
	});
	const body = await res.json();
	if (!res.ok) return { text: body.error ?? res.statusText, is_error: true };
	return body;
}

function emit(frame) {
	process.stdout.write(
		`${JSON.stringify({ session_id: cliSessionId, uuid: randomUUID(), ...frame })}\n`,
	);
}

const memoryFile = () =>
	join(proxyFlag("--data-dir"), "walkthrough-cli", `${cliSessionId}.json`);

const toolUseId = () => `toolu_${randomUUID().replaceAll("-", "")}`;

// Permission requests waiting on Pockode's answer, by request_id.
const awaitingPermission = new Map();
// Set while a turn hangs on purpose.
let endHang = null;
// Set while a turn holds at a gate.
let leaveGate = null;
// What the turn being played says it spent (a scenario's `usage`), and what
// this process has spent in all, which is how the CLI's result frame counts.
let turnUsage = null;
const spent = { modelUsage: {}, costUsd: 0 };

// What the real CLI does on an interrupt: whatever the turn was waiting on
// ends — a permission request as denied — and the turn finishes.
function interrupt() {
	for (const resolve of awaitingPermission.values())
		resolve({ behavior: "deny", message: "Interrupted" });
	awaitingPermission.clear();
	endHang?.();
	endHang = null;
	leaveGate?.();
	leaveGate = null;
}

/**
 * What a scenario writes its turn with. Every method emits the frames the real
 * CLI would for that step; `parent` is the Agent call a subagent's frames
 * belong under (parent_tool_use_id).
 */
const agent = {
	cwd: process.cwd(),

	frame: emit,

	message(content, parent) {
		emit({
			type: "assistant",
			...(parent && { parent_tool_use_id: parent }),
			message: {
				id: `msg_${randomUUID()}`,
				role: "assistant",
				model: "fake-walkthrough",
				content,
				...(turnUsage && {
					usage: {
						input_tokens: turnUsage.contextTokens,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
		});
	},

	say(text, parent) {
		agent.message([{ type: "text", text }], parent);
	},

	think(thinking) {
		agent.message([{ type: "thinking", thinking, signature: "" }]);
	},

	/** Starts a tool call and returns its tool_use_id. */
	call(name, input, parent) {
		const id = toolUseId();
		agent.message([{ type: "tool_use", id, name, input }], parent);
		return id;
	},

	result(id, content, { isError = false, parent } = {}) {
		emit({
			type: "user",
			...(parent && { parent_tool_use_id: parent }),
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: id,
						content,
						is_error: isError,
					},
				],
			},
		});
	},

	/** A call and its result in one step. */
	tool(name, input, content, options = {}) {
		const id = agent.call(name, input, options.parent);
		agent.result(id, content, options);
		return id;
	},

	/**
	 * Asks Pockode for permission to run `id` and waits for the answer, then
	 * writes the call's result: `ran` if allowed, a denial if not.
	 */
	async permission(id, name, input, ran, suggestions = []) {
		const requestId = randomUUID();
		emit({
			type: "control_request",
			request_id: requestId,
			request: {
				subtype: "can_use_tool",
				tool_name: name,
				input,
				tool_use_id: id,
				permission_suggestions: suggestions,
			},
		});
		const answer = await new Promise((resolve) =>
			awaitingPermission.set(requestId, resolve),
		);
		if (answer.behavior === "allow") agent.result(id, ran);
		else
			agent.result(id, answer.message || "The user denied this tool use.", {
				isError: true,
			});
	},

	/**
	 * Calls a Pockode tool through the real MCP path, as its row in the
	 * transcript, and returns the result's text. A refused call fails the turn:
	 * a scenario that is refused has stopped being the one it describes.
	 */
	async mcp(name, input) {
		const id = agent.call(`mcp__pockode__${name}`, input);
		const result = await callTool(name, input);
		agent.result(id, [{ type: "text", text: result.text }], {
			isError: !!result.is_error,
		});
		if (result.is_error) throw new Error(`${name}: ${result.text}`);
		return result.text;
	},

	/** Posts questions through the real MCP path, as question_post does. */
	async ask(questions) {
		const input = { questions };
		const id = agent.call("mcp__pockode__question_post", input);
		// The call goes over HTTP and the frame above over stdout, and the HTTP
		// request can win: the question then lands before its call, and the
		// transcript draws them as two rows rather than one card. The real CLI
		// streams the call long before it runs it. Nothing here can see when the
		// server has read the frame, so this only makes losing unlikely; the
		// marketing suite checks the order the server recorded and fails if
		// it was lost.
		await agent.sleep(500);
		const result = await callTool("question_post", input);
		agent.result(id, [{ type: "text", text: result.text }], {
			isError: !!result.is_error,
		});
		if (result.is_error) throw new Error(`question_post: ${result.text}`);
	},

	/**
	 * Holds the turn, with the call `pending` still running, until the suite
	 * lets it through — which is how a suite driving several agents at once
	 * decides the order they move in. Both ends are files in the server's data
	 * directory: `<name>.parked` names the running call once its frame is on
	 * stdout, so the suite can wait for the server to have recorded it, and the
	 * suite creating `<name>` lets the turn on. An interrupt ends the turn
	 * instead, as it would a real one.
	 */
	async gate(name, pending = "") {
		const dir = join(proxyFlag("--data-dir"), "walkthrough-gates");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.parked`), pending);
		let interrupted = false;
		leaveGate = () => {
			interrupted = true;
		};
		while (!existsSync(join(dir, name))) {
			if (interrupted) throw new Error(`interrupted at ${name}`);
			await agent.sleep(100);
		}
		leaveGate = null;
	},

	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

	/**
	 * What this conversation knows from earlier turns — the ids its kickoff
	 * named, say. Kept on disk under the CLI's session id, as the real CLI
	 * keeps its transcript, so a process Pockode restarts with --resume still
	 * knows it.
	 */
	get memory() {
		const file = memoryFile();
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	},

	remember(values) {
		const file = memoryFile();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ ...agent.memory, ...values }));
	},

	/**
	 * Leaves the turn open until it is interrupted, so the page finds it still
	 * running. With `thinking`, it keeps saying it is thinking the way the CLI
	 * does, a thinking_tokens frame every so often. The server announces only
	 * the first of a stretch, so the tail line says `Thinking…` only on a page
	 * that was watching when the stretch began.
	 */
	async hang({ thinking = false } = {}) {
		let tokens = 0;
		const ticker = thinking
			? setInterval(() => {
					tokens += 40;
					emit({ type: "system", subtype: "thinking_tokens", tokens });
				}, 500)
			: null;
		await new Promise((resolve) => {
			endHang = resolve;
		});
		clearInterval(ticker);
	},
};

function promptText(frame) {
	const content = frame.message?.content;
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function questionScenarioFor(text) {
	const asked = Object.values(SCENARIOS).find((s) => s.prompt === text.trim());
	if (asked) return asked;
	if (text.includes("(Work ID: ")) return SCENARIOS.work;
	return null;
}

async function runTurn(text) {
	emit({ type: "system", subtype: "init", model: "fake-walkthrough" });

	// A scenario that `follows` another plays only in the conversation that
	// remembers being that one (`agent.remember`).
	const played = [...Object.values(CHAT), ...Object.values(MARKETING)].find(
		(s) =>
			text.includes(s.prompt) &&
			(!s.follows || agent.memory.task === s.follows),
	);
	// After `played`: a marketing work's messages are work messages too.
	const asked = played ? null : questionScenarioFor(text);
	turnUsage = played?.usage ?? null;
	if (asked) {
		agent.say(asked.lead);
		await agent.ask(asked.questions);
		agent.say("Asked. I'll carry on once you answer.");
	} else if (played) {
		await played.play(agent, text);
	} else if (text.startsWith("Answering:")) {
		agent.say("Thanks — going with that.");
	} else {
		agent.say("Noted.");
	}

	if (turnUsage) {
		for (const [model, add] of Object.entries(turnUsage.modelUsage)) {
			const total = spent.modelUsage[model];
			if (!total) spent.modelUsage[model] = { ...add };
			else
				for (const key of Object.keys(add))
					if (key !== "contextWindow") total[key] += add[key];
		}
		spent.costUsd += turnUsage.costUsd;
	}
	emit({
		type: "result",
		subtype: "success",
		is_error: false,
		terminal_reason: "completed",
		result: "",
		...(turnUsage && {
			modelUsage: spent.modelUsage,
			total_cost_usd: spent.costUsd,
		}),
	});
}

// Turns are run one at a time, as the real CLI does with queued input.
let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	if (!line.trim()) return;
	let frame;
	try {
		frame = JSON.parse(line);
	} catch {
		console.error(`fake claude: unreadable input line: ${line}`);
		return;
	}
	if (frame.type === "control_response") {
		const id = frame.response?.request_id;
		awaitingPermission.get(id)?.(frame.response?.response ?? {});
		awaitingPermission.delete(id);
		return;
	}
	if (frame.type === "control_request") {
		emit({
			type: "control_response",
			response: { subtype: "success", request_id: frame.request_id },
		});
		if (frame.request?.subtype === "interrupt") interrupt();
		return;
	}
	if (frame.type !== "user") return;
	const text = promptText(frame);
	queue = queue
		.then(() => runTurn(text))
		.catch((err) => {
			console.error(`fake claude: turn failed: ${err.stack ?? err}`);
			emit({
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: [String(err)],
			});
		});
});
rl.on("close", () => {
	queue.then(() => process.exit(0));
});
