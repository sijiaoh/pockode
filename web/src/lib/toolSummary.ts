import type { WorkRef } from "../types/message";
import type { WorkType } from "../types/work";
import {
	isSameNativePath,
	relativeToWorkDir,
	splitNativePath,
} from "../utils/path";
import { codexChangePaths } from "./codexChanges";
import {
	AGENT_CONTROL_TOOL,
	agentControlDetail,
	agentControlInput,
	GENERATE_IMAGE_TOOL,
	generateImagePrompt,
	SLEEP_TOOL,
} from "./codexTools";
import {
	htmlEditInput,
	htmlGetInput,
	htmlRenderInput,
	isHtmlEditTool,
	isHtmlGetTool,
	isHtmlRenderTool,
} from "./htmlRender";
import { reviewCategoryLabel } from "./permissionReview";
import {
	pockodeWorkTool,
	workToolDetail,
	workToolVerb,
} from "./pockodeWorkTools";
import { firstLine } from "./subagentRun";
import { isStopTool, stoppedTaskId } from "./taskStop";

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
 * when it was recorded. Both render as the same part. Codex's subagent spawn
 * arrives as `Task` too: the server names it so, because it is the same thing
 * (docs/code/agent-integration.md#subagent-threads).
 */
export function isTaskTool(toolName: string): boolean {
	return toolName === "Task" || toolName === "Agent";
}

/**
 * The name the reducer gives a Codex `plan` record's row: a plan with no call
 * behind it, drawn as a call so lists and groups need no special case
 * (docs/turn-progress-ui.md#46-the-plan-record). Its input is
 * `{ steps: PlanStep[], explanation? }`.
 */
export const PLAN_TOOL_NAME = "Plan";

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

/**
 * What a subagent call was asked to do, for quoting the call in one line.
 *
 * A Codex spawn carries no description: one shape has only the agent's path —
 * `/root/read_a`, whose last segment is the name the model gave the agent for
 * its task — so that name stands in; the other has only the prompt, whose
 * first line does.
 */
export function taskDescription(input: unknown): string {
	const obj = asObject(input);
	return (
		str(obj.description) ??
		str(obj.subagent_type) ??
		str(str(obj.agent_path)?.split("/").pop()) ??
		str(firstLine(str(obj.prompt) ?? "")) ??
		SUBAGENT_TITLE
	);
}

/**
 * Which agent a subagent call ran, in full: Claude's `subagent_type` as given
 * (`pr-review-toolkit:code-reviewer`), or the last segment of a Codex agent's
 * path. Undefined when the call named none.
 */
export function subagentType(input: unknown): string | undefined {
	const obj = asObject(input);
	return str(obj.subagent_type) ?? str(str(obj.agent_path)?.split("/").pop());
}

/**
 * A subagent row's title: the agent, without a plugin's `plugin:` prefix —
 * where the agent came from, which the facts line keeps. `Subagent` when the
 * call named none, rather than a guess at the CLI's default
 * (docs/tool-call-ui.md#line-1-the-agent-then-what-it-was-asked).
 */
export function subagentName(input: unknown): string {
	return subagentType(input)?.split(":").pop() || SUBAGENT_TITLE;
}

/** The title of a subagent row whose call named no agent. */
export const SUBAGENT_TITLE = "Subagent";

/**
 * What names a subagent's things after its row's title — `Explore subagent's
 * process` — without saying it twice on a row already titled `Subagent`.
 */
export function subagentPossessive(title: string): string {
	return title === SUBAGENT_TITLE ? "Subagent's" : `${title} subagent's`;
}

/**
 * A path split for one line — the row's, and a tool body's `PathLine`: the
 * directories, which may fade out, and the file name, which may not.
 *
 * `truncate` removes the tail of a string, and a path's tail is the one part
 * that identifies it — so the two halves are drawn separately and only the
 * first is allowed to be cut. The path is shown relative to the work directory
 * when it is inside it, which is both shorter and what the Files tab names it.
 */
export function pathParts(
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

/**
 * The tools whose call is about one file, named by its `file_path` or `path`.
 * A name, not the field, decides it: an MCP tool or one we do not know may take
 * a `path` too, and drawing it as a file would put its whole machine name in
 * the title and leave every other argument out of the body
 * (docs/tool-call-ui.md). `NotebookEdit` is not here: its input is the cell it
 * writes, which the body would then hide.
 */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "LS"]);

/** The file a known file tool's call is about, if it is one. */
export function fileToolPath(
	toolName: string,
	input: unknown,
): string | undefined {
	if (!FILE_TOOLS.has(toolName)) return undefined;
	const obj = asObject(input);
	return str(obj.file_path) ?? str(obj.path);
}

function pathSummary(
	title: string,
	filePath: string,
	workDir: string,
): ToolSummary {
	const { head, tail } = pathParts(filePath, workDir);
	return { title, detail: head, detailTail: tail, mono: true };
}

/**
 * Where a search ran, as its row names it. Claude nearly always passes an
 * absolute path, which on a phone left room for the home directory and nothing
 * else — so a scope inside the work directory is named relative to it, and the
 * work directory itself, being where every search runs anyway, is not named.
 */
function grepScope(scope: string | undefined, workDir: string) {
	if (!scope) return undefined;
	if (workDir && isSameNativePath(scope, workDir)) return undefined;
	return relativeToWorkDir(scope, workDir) ?? scope;
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

/** A `TodoWrite`'s `todos`, or a `Plan` row's `steps`: the same wording. */
function todoSummary(title: string, items: unknown): ToolSummary {
	if (!Array.isArray(items)) {
		return { title, detail: "", detailTail: "", mono: false };
	}
	const done = items.filter(
		(item) => asObject(item).status === "completed",
	).length;
	return {
		title,
		detail: `${done} done / ${items.length}`,
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
	/** The work a Pockode work tool acted on, as the call's result names it. */
	workRef?: WorkRef,
): ToolSummary {
	const obj = asObject(input);

	if (isTaskTool(toolName)) {
		return {
			title: subagentName(input),
			detail: str(obj.description) ?? firstLine(str(obj.prompt) ?? ""),
			detailTail: "",
			mono: false,
		};
	}

	if (toolName === "Bash") return bashSummary(input, workDir);
	if (toolName === "TodoWrite") {
		return todoSummary(toolName, asObject(input).todos);
	}
	if (toolName === PLAN_TOOL_NAME) {
		return todoSummary(toolName, asObject(input).steps);
	}

	// The call that reads a task's output, on the rows where it could not be
	// filed under the call it reads. The fallback lands on the same field today,
	// but by the order `Object.values` happens to return — one more string in the
	// input and it would name something else. Mono because a task id is not
	// prose.
	if (toolName === "TaskOutput") {
		return {
			title: "TaskOutput",
			detail: str(obj.task_id) ?? "",
			detailTail: "",
			mono: true,
		};
	}
	// Named by their key for the reason `TaskOutput` is. `BashOutput` is
	// history only: no current CLI offers it.
	if (toolName === "BashOutput") {
		return {
			title: "BashOutput",
			detail: str(obj.bash_id) ?? "",
			detailTail: "",
			mono: true,
		};
	}
	if (isStopTool(toolName)) {
		return {
			title: toolName,
			detail: stoppedTaskId(input) ?? "",
			detailTail: "",
			mono: true,
		};
	}
	if (toolName === GENERATE_IMAGE_TOOL) {
		return {
			title: GENERATE_IMAGE_TOOL,
			detail: firstLine(generateImagePrompt(input) ?? ""),
			detailTail: "",
			mono: false,
		};
	}
	// The duration is the meta; the wait asked for is in the body.
	if (toolName === SLEEP_TOOL) {
		return { title: SLEEP_TOOL, detail: "", detailTail: "", mono: false };
	}
	if (toolName === AGENT_CONTROL_TOOL) {
		const { title, agents } = agentControlInput(input);
		return {
			title,
			detail: agentControlDetail(agents),
			detailTail: "",
			mono: false,
		};
	}
	// Read like the file tool it is. The mode is a chip because `insert` and
	// `delete` change what the row means, and `replace`, the default, does not.
	if (toolName === "NotebookEdit") {
		const path = str(obj.notebook_path);
		const mode = obj.edit_mode;
		const chip = mode === "insert" || mode === "delete" ? mode : undefined;
		return {
			...(path
				? pathSummary("NotebookEdit", path, workDir)
				: fallbackSummary(toolName, input)),
			...(chip ? { chip } : {}),
		};
	}

	// Before the path branch: a scope is not the thing the call is about, and a
	// `Grep` identified by the directory it searched says nothing about what it
	// searched for.
	if (toolName === "Grep") {
		const pattern = str(obj.pattern) ?? "";
		const scope = grepScope(str(obj.path), workDir);
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

	const filePath = fileToolPath(toolName, input);
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
	// Named by its title: the first value would as often be the whole page.
	if (mcp && isHtmlRenderTool(toolName)) {
		return { ...mcpSummary(mcp, {}), detail: htmlRenderInput(input).title };
	}
	// Named by the page it starts from, the one thing the reader can find
	// above; the edits are as long as they like.
	if (mcp && isHtmlEditTool(toolName)) {
		const { base, title } = htmlEditInput(input);
		const from = base ? `from ${base}` : "";
		return {
			...mcpSummary(mcp, {}),
			detail: title && from ? `${title} · ${from}` : title || from,
		};
	}
	if (mcp && isHtmlGetTool(toolName)) {
		return { ...mcpSummary(mcp, {}), detail: htmlGetInput(input).id };
	}
	if (mcp?.server === "pockode" && mcp.tool === "permission_verdict") {
		return verdictSummary(input);
	}
	const workTool = pockodeWorkTool(toolName);
	if (mcp && workTool) {
		return {
			...mcpSummary(mcp, {}),
			title: workTool.title,
			...workToolDetail(workTool, input, workRef),
		};
	}
	if (mcp) return mcpSummary(mcp, input);

	return fallbackSummary(toolName, input);
}

/**
 * A permission reviewer's answer, named by what it decided rather than by its
 * first field, which is a request id nobody reads (docs/unattended-mode-ui.md
 * §5.1). The reason is the detail: it is what a reader of the reviewer's
 * transcript wants to see beside the verdict.
 */
function verdictSummary(input: unknown): ToolSummary {
	const obj = asObject(input);
	const verdict = str(obj.verdict);
	const category = str(obj.category);
	const title =
		verdict === "allow"
			? "Verdict: Allow"
			: verdict === "deny"
				? category
					? `Verdict: Deny · ${reviewCategoryLabel(category)}`
					: "Verdict: Deny"
				: "permission_verdict";
	return {
		title,
		detail: str(obj.reason) ?? "",
		detailTail: "",
		mono: false,
	};
}

/**
 * What kind of thing a call did, for the one-line summary a run of calls folds
 * into (docs/tool-call-ui.md#groups). Ordered by consequence: a reader skimming
 * a folded run wants to know first what was changed and what was run, and a
 * narrow screen cuts the end of the line.
 */
export const TOOL_VERBS = [
	"edit",
	"create",
	"start",
	"run",
	"stop",
	"read",
	"search",
	"fetch",
	"todo",
	"other",
] as const;

export type ToolVerb = (typeof TOOL_VERBS)[number];

export interface ToolVerbReading {
	verb: ToolVerb;
	/**
	 * The files the call touched, for the verbs counted in files rather than in
	 * calls. Absent when the input names none; the call then counts once.
	 */
	paths?: string[];
	/**
	 * What a call counted as a call is named by in the summary, and the identity
	 * its repeats are folded on: `pnpm test` twice is `pnpm test ×2`. Absent for
	 * a file-counted call (its files name it) and for a call with nothing to name
	 * it by, which is still counted.
	 */
	name?: string;
	/**
	 * The kind of work a `create` or `start` acted on, which its count is
	 * worded by: `Created 2 tasks`, `Started 3 work items` when they differ.
	 */
	kind?: WorkType;
}

function filePaths(obj: Record<string, unknown>): string[] | undefined {
	const path = str(obj.file_path) ?? str(obj.notebook_path) ?? str(obj.path);
	return path ? [path] : undefined;
}

// A lone `&` too: what follows a backgrounded command is another command.
const SHELL_OPERATOR = /&&|\|\||\||;|⏎|&/;

/** One shell word, quoted or not: what a `cd` or an assignment takes. */
const SHELL_WORD = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const LEADING_CD = new RegExp(String.raw`^cd\s+${SHELL_WORD}\s*(?:&&|;|⏎)\s*`);
/** A comment line ahead of the command, as a here-doc'd script opens. */
const LEADING_COMMENT = /^#[^⏎]*⏎\s*/;
const LEADING_ASSIGNMENT = new RegExp(
	String.raw`^[A-Za-z_][A-Za-z0-9_]*=${SHELL_WORD}?\s+`,
);

/**
 * What a reader recognises a command by: its first few words, before the
 * flags, the quoted arguments and whatever it was piped or chained into. The
 * `cd`, the variables and the comments in front are where and how it ran, or
 * notes on it, not what ran. Nothing marks the cut — the row is one tap away
 * and has the whole command.
 */
export function commandHead(command: string): string | undefined {
	let rest = flattenCommand(command);
	for (;;) {
		const stripped = rest
			.replace(LEADING_CD, "")
			.replace(LEADING_COMMENT, "")
			.replace(LEADING_ASSIGNMENT, "");
		if (stripped === rest) break;
		rest = stripped;
	}
	const words: string[] = [];
	for (const word of rest.split(SHELL_OPERATOR)[0].split(/\s+/)) {
		if (!word) continue;
		// A flag, a quoted argument or a redirection (`2>&1`, `<<EOF`).
		if (/^([-"'`]|\d*[<>])/.test(word) || words.length === 3) break;
		words.push(word);
	}
	return words.length > 0 ? words.join(" ") : undefined;
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).host || undefined;
	} catch {
		return undefined;
	}
}

const quoted = (text: string | undefined) =>
	text === undefined ? undefined : `"${text}"`;

/**
 * The verb a call is summarised under, and what it is named by there. The
 * same table of knowledge as `toolSummary`, and a Codex `Bash` is read through
 * the same `singleCommandAction`: the summary has to say what the rows under
 * it say. A search is named by what it looked for, never by where — the row
 * has the scope.
 */
export function toolVerb(
	toolName: string,
	input: unknown,
	workRef?: WorkRef,
): ToolVerbReading {
	const obj = asObject(input);
	const workTool = pockodeWorkTool(toolName);
	if (workTool) return workToolVerb(workTool, input, workRef);
	switch (toolName) {
		case "Write":
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			// One Codex file change can name several files.
			return {
				verb: "edit",
				paths:
					(toolName === "Edit" ? codexChangePaths(input) : null) ??
					filePaths(obj),
			};
		case "Bash": {
			const action = singleCommandAction(input);
			const path = str(action?.path);
			if (action?.type === "read") {
				return { verb: "read", paths: path ? [path] : undefined };
			}
			if (action?.type === "search") {
				return { verb: "search", name: quoted(str(action.query)) };
			}
			if (action?.type === "listFiles") {
				const dir = path && splitNativePath(path).at(-1);
				return { verb: "search", name: dir ? `${dir}/` : undefined };
			}
			const command = str(obj.command);
			return { verb: "run", name: command && commandHead(command) };
		}
		case "TaskStop":
		case "KillShell":
		case "KillBash":
			return { verb: "stop" };
		case "Read":
			return { verb: "read", paths: filePaths(obj) };
		case "Grep":
		case "WebSearch":
			return {
				verb: "search",
				name: quoted(str(obj.pattern) ?? str(obj.query)),
			};
		case "Glob":
			return { verb: "search", name: str(obj.pattern) };
		case "WebFetch": {
			const url = str(obj.url);
			return { verb: "fetch", name: url && hostOf(url) };
		}
		case "TodoWrite":
		case PLAN_TOOL_NAME:
			return { verb: "todo" };
		// By what it did — `Used Wait` — rather than by Pockode's umbrella name.
		case AGENT_CONTROL_TOOL:
			return { verb: "other", name: agentControlInput(input).title };
		default:
			return {
				verb: "other",
				name: splitMcpName(toolName)?.tool ?? toolName,
			};
	}
}

/** The row's summary as one line of text: `Bash · pnpm test`. */
export function toolSummaryLine(summary: ToolSummary): string {
	return [summary.title, summary.detail + summary.detailTail]
		.filter(Boolean)
		.join(" · ");
}
