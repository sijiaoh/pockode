// A stand-in for the `claude` CLI, put first on the walkthrough server's PATH
// (through the `claude` wrapper beside it) so that an agent asking questions is
// something that happens on demand, the same way every run, and costs nothing.
//
// It speaks just enough stream-json for Pockode to run a turn, and it asks
// through the real path: question_post goes to the server's local MCP API with
// this process's own session identity, exactly what the stdio proxy would send,
// so the transcript gets the tool row, the question_posted records and the
// session's unanswered list just as a real agent's call would leave them.
//
// What it asks is picked by the prompt (see scenarios.mjs):
//   - a prompt that is exactly a scenario's `prompt` asks that scenario;
//   - a work's kickoff prompt ("(Work ID: ...") asks scenario "work";
//   - anything else, answers included, is acknowledged in one line.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SCENARIOS } from "../scenarios.mjs";

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

function assistant(content) {
	emit({
		type: "assistant",
		message: {
			id: `msg_${randomUUID()}`,
			role: "assistant",
			model: "fake-walkthrough",
			content,
		},
	});
}

function promptText(frame) {
	const content = frame.message?.content;
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function scenarioFor(text) {
	const asked = Object.values(SCENARIOS).find((s) => s.prompt === text.trim());
	if (asked) return asked;
	if (text.includes("(Work ID: ")) return SCENARIOS.work;
	return null;
}

async function runTurn(text) {
	emit({ type: "system", subtype: "init", model: "fake-walkthrough" });

	const scenario = scenarioFor(text);
	if (scenario) {
		assistant([{ type: "text", text: scenario.lead }]);
		const toolUseId = `toolu_${randomUUID().replaceAll("-", "")}`;
		const input = { questions: scenario.questions };
		assistant([
			{
				type: "tool_use",
				id: toolUseId,
				name: "mcp__pockode__question_post",
				input,
			},
		]);
		const result = await callTool("question_post", input);
		emit({
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolUseId,
						content: [{ type: "text", text: result.text }],
						is_error: !!result.is_error,
					},
				],
			},
		});
		assistant([
			{ type: "text", text: "Asked. I'll carry on once you answer." },
		]);
	} else if (text.startsWith("Answering:")) {
		assistant([{ type: "text", text: "Thanks — going with that." }]);
	} else {
		assistant([{ type: "text", text: "Noted." }]);
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
	if (frame.type === "control_request") {
		emit({
			type: "control_response",
			response: { subtype: "success", request_id: frame.request_id },
		});
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
