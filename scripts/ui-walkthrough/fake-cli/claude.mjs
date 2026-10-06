// A stand-in for the `claude` CLI, put first on the walkthrough server's PATH
// (through the `claude` wrapper beside it) so that an agent's turn is something
// that happens on demand, the same way every run, and costs nothing.
//
// It speaks just enough stream-json for Pockode to run a turn. When it asks a
// question it asks through the real path: question_post goes to the server's
// local MCP API with this process's own session identity, exactly what the
// stdio proxy would send, so the transcript gets the tool row, the
// question_posted records and the session's unanswered list just as a real
// agent's call would leave them.
//
// What it does is picked by the prompt:
//   - a prompt that is exactly a question scenario's `prompt` asks that
//     scenario (../question/scenarios.mjs);
//   - a work's kickoff prompt ("(Work ID: ...") asks scenario "work";
//   - a prompt containing a chat scenario's `prompt` plays that scenario's
//     turn (../chat/scenarios.mjs) — "containing", because a message with
//     attachments reaches the CLI with their paths beside the text;
//   - anything else, answers included, is acknowledged in one line.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CHAT } from "../chat/scenarios.mjs";
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

// The identity the stdio proxy would have been spawned with, read back out of
// the MCP config Pockode wrote for this process.
function mcpCaller() {
	const configPath = argValue("--mcp-config");
	if (!configPath) throw new Error("no --mcp-config: Pockode tools disabled");
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const proxyArgs = config.mcpServers.pockode.args;
	const flag = (name) => {
		const i = proxyArgs.indexOf(name);
		return i >= 0 ? proxyArgs[i + 1] : undefined;
	};
	const info = JSON.parse(
		readFileSync(join(flag("--data-dir"), "server.json"), "utf8"),
	);
	return {
		url: `${info.local_url || `http://localhost:${info.port}`}/api/mcp/tools/call`,
		token: info.token,
		caller: { session_id: flag("--session-id"), worktree: flag("--worktree") },
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

const toolUseId = () => `toolu_${randomUUID().replaceAll("-", "")}`;

// Permission requests waiting on Pockode's answer, by request_id.
const awaitingPermission = new Map();
// Set while a turn hangs on purpose.
let endHang = null;

// What the real CLI does on an interrupt: whatever the turn was waiting on
// ends — a permission request as denied — and the turn finishes.
function interrupt() {
	for (const resolve of awaitingPermission.values())
		resolve({ behavior: "deny", message: "Interrupted" });
	awaitingPermission.clear();
	endHang?.();
	endHang = null;
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

	/** Posts questions through the real MCP path, as question_post does. */
	async ask(questions) {
		const input = { questions };
		const id = agent.call("mcp__pockode__question_post", input);
		const result = await callTool("question_post", input);
		agent.result(id, [{ type: "text", text: result.text }], {
			isError: !!result.is_error,
		});
	},

	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

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

	const asked = questionScenarioFor(text);
	const played = Object.values(CHAT).find((s) => text.includes(s.prompt));
	if (asked) {
		agent.say(asked.lead);
		await agent.ask(asked.questions);
		agent.say("Asked. I'll carry on once you answer.");
	} else if (played) {
		await played.play(agent);
	} else if (text.startsWith("Answering:")) {
		agent.say("Thanks — going with that.");
	} else {
		agent.say("Noted.");
	}

	emit({
		type: "result",
		subtype: "success",
		is_error: false,
		terminal_reason: "completed",
		result: "",
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
