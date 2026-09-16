import { relativeToWorkDir, splitNativePath } from "../utils/path";

/**
 * What a tool call's row says about itself: a title naming the kind of call,
 * and a detail identifying this particular one.
 *
 * Derived here from the name and the input rather than sent on the wire — a
 * display string on the wire is a second representation of data already there,
 * and it freezes a formatting decision into history
 * (docs/tool-call-model.md#toolrun). Only the detail is ever truncated, so only
 * it may be long.
 */
export interface ToolSummary {
	title: string;
	/**
	 * The part that may be cut. Truncates from the right, except that whatever
	 * `detailTail` holds is kept whole and sits after it.
	 */
	detail: string;
	/**
	 * The identifying end of a path — the file name — which right-hand
	 * truncation would be the first to remove. Empty for a detail that is not a
	 * path.
	 */
	detailTail: string;
	/** A short label after the title: a subagent type, an MCP server. */
	chip?: string;
	/** Whether the detail is literal machine text rather than prose. */
	mono: boolean;
}

/**
 * The subagent tool goes by two names: the CLI renamed `Task` to `Agent`
 * (2.1.x emits `Agent`), and stored history holds whichever name was current
 * when it was recorded. Both render as the same part.
 */
export function isTaskTool(toolName: string): boolean {
	return toolName === "Task" || toolName === "Agent";
}

function asObject(input: unknown): Record<string, unknown> {
	return input && typeof input === "object"
		? (input as Record<string, unknown>)
		: {};
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A subagent call's brief, which is the only place the prompt is readable. */
export function taskPrompt(input: unknown): string | undefined {
	return str(asObject(input).prompt);
}

/** What a subagent call was asked to do, for quoting the call in one line. */
export function taskDescription(input: unknown): string {
	const obj = asObject(input);
	return str(obj.description) ?? str(obj.subagent_type) ?? "Task";
}

/**
 * A path split for a row: the directories, which may fade out, and the file
 * name, which may not.
 *
 * `truncate` removes the tail of a string, and a path's tail is the one part
 * that identifies it — so the two halves are drawn separately and only the
 * first is allowed to be cut. The path is shown relative to the work directory
 * when it is inside it, which is both shorter and what the Files tab names it.
 */
function pathParts(
	filePath: string,
	workDir: string,
): { head: string; tail: string } {
	const relative = relativeToWorkDir(filePath, workDir);
	const shown = relative ?? filePath;
	const segments = splitNativePath(shown);
	if (segments.length === 0) return { head: "", tail: shown };
	const tail = segments[segments.length - 1];
	const head = shown.slice(0, shown.length - tail.length);
	return { head, tail };
}

function pathSummary(
	title: string,
	filePath: string,
	workDir: string,
): ToolSummary {
	const { head, tail } = pathParts(filePath, workDir);
	return { title, detail: head, detailTail: tail, mono: true };
}

interface CommandAction {
	type?: unknown;
	command?: unknown;
	query?: unknown;
	path?: unknown;
}

/**
 * Codex's own parse of the command it is about to run, when it produced
 * exactly one reading of it. Several piped parts, or a part it could not
 * classify, leave the command itself as the only honest summary.
 */
function singleCommandAction(input: unknown): CommandAction | null {
	const actions = asObject(input).command_actions;
	if (!Array.isArray(actions) || actions.length !== 1) return null;
	const action = actions[0] as CommandAction;
	return action && typeof action === "object" ? action : null;
}

/** A Bash command on one line: the newlines a here-doc brings are not rows. */
function flattenCommand(command: string): string {
	return command.replace(/\s*\n+\s*/g, " ⏎ ").trim();
}

function bashSummary(input: unknown, workDir: string): ToolSummary {
	const obj = asObject(input);
	const action = singleCommandAction(input);
	const actionPath = str(action?.path);
	if (action?.type === "read" || action?.type === "listFiles") {
		if (actionPath) return pathSummary("Bash", actionPath, workDir);
	}
	if (action?.type === "search") {
		const query = str(action.query);
		if (query) {
			return {
				title: "Bash",
				detail: actionPath ? `"${query}" in ${actionPath}` : `"${query}"`,
				detailTail: "",
				mono: true,
			};
		}
	}

	const command = str(obj.command);
	return {
		title: "Bash",
		// The command, not `description`: a paraphrase is not what ran, and on a
		// phone this row is frequently the only audit anyone performs. The
		// description is not lost — it is the first line of the body.
		detail: command ? flattenCommand(command) : "",
		detailTail: "",
		mono: true,
	};
}

function todoSummary(input: unknown): ToolSummary {
	const todos = asObject(input).todos;
	if (!Array.isArray(todos)) {
		return { title: "TodoWrite", detail: "", detailTail: "", mono: false };
	}
	const done = todos.filter(
		(todo) => asObject(todo).status === "completed",
	).length;
	return {
		title: "TodoWrite",
		detail: `${done} done / ${todos.length}`,
		detailTail: "",
		mono: false,
	};
}

/**
 * An MCP tool's two halves, or null when the name is not one.
 *
 * Two spellings reach here, because the two CLIs name these differently:
 * Codex's adapter joins them as `server:tool` (the name is the only place it
 * can put them), and Claude passes its own `mcp__server__tool` through
 * verbatim. Both are one server and one tool, and the row draws them the same
 * way — the tool as the title, the server as a chip — rather than putting a
 * 40-character machine name in a slot that never truncates.
 */
function splitMcpName(
	toolName: string,
): { server: string; tool: string } | null {
	if (toolName.startsWith("mcp__")) {
		const [server, ...rest] = toolName.slice("mcp__".length).split("__");
		if (server && rest.length > 0) return { server, tool: rest.join("__") };
		return null;
	}
	const [server, ...rest] = toolName.split(":");
	if (server && rest.length > 0) return { server, tool: rest.join(":") };
	return null;
}

function mcpSummary(
	{ server, tool }: { server: string; tool: string },
	input: unknown,
): ToolSummary {
	const obj = asObject(input);
	const first = Object.values(obj).find(
		(value) =>
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean",
	);
	return {
		title: tool,
		chip: server,
		detail: first === undefined ? "" : String(first),
		detailTail: "",
		mono: false,
	};
}

function fallbackSummary(toolName: string, input: unknown): ToolSummary {
	const obj = asObject(input);
	const first = Object.values(obj).find(
		(value) => typeof value === "string" && value.length > 0,
	);
	return {
		title: toolName,
		detail: typeof first === "string" ? flattenCommand(first) : "",
		detailTail: "",
		mono: false,
	};
}

/**
 * How one tool call reads on its row.
 *
 * Nothing here slices a string to a character count: the row truncates at the
 * width it actually has, and a second policy that guesses how wide the screen
 * is can only disagree with it.
 */
export function toolSummary(
	toolName: string,
	input: unknown,
	workDir: string,
): ToolSummary {
	const obj = asObject(input);

	if (isTaskTool(toolName)) {
		return {
			title: "Task",
			chip: str(obj.subagent_type),
			detail: taskDescription(input),
			detailTail: "",
			mono: false,
		};
	}

	if (toolName === "Bash") return bashSummary(input, workDir);
	if (toolName === "TodoWrite") return todoSummary(input);

	// Before the path branch: a scope is not the thing the call is about, and a
	// `Grep` identified by the directory it searched says nothing about what it
	// searched for.
	if (toolName === "Grep") {
		const pattern = str(obj.pattern) ?? "";
		const scope = str(obj.path);
		return {
			title: "Grep",
			detail: scope ? `"${pattern}" in ${scope}` : `"${pattern}"`,
			detailTail: "",
			mono: true,
		};
	}
	if (toolName === "Glob") {
		return {
			title: "Glob",
			detail: str(obj.pattern) ?? "",
			detailTail: "",
			mono: true,
		};
	}

	const filePath = str(obj.file_path) ?? str(obj.path);
	if (filePath) return pathSummary(toolName, filePath, workDir);

	if (toolName === "WebFetch" || toolName === "WebSearch") {
		const url = str(obj.url);
		return {
			title: toolName,
			detail: url ? url.replace(/^https?:\/\//, "") : (str(obj.query) ?? ""),
			detailTail: "",
			mono: false,
		};
	}

	const mcp = splitMcpName(toolName);
	if (mcp) return mcpSummary(mcp, input);

	return fallbackSummary(toolName, input);
}
