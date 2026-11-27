import type { WorkRef } from "../types/message";
import type { WorkType } from "../types/work";
import { pockodeTool } from "./pockodeTool";
import { firstLine } from "./subagentRun";

/**
 * Pockode's own work tools, read as what they did: the one table the row's
 * title, the group summary's verb and the body all read, so the three cannot
 * name a call differently (docs/tool-call-ui.md#pockodes-own-work-calls). The
 * page tools, `permission_verdict` and the question tools are not here: each
 * has a row or a card of its own.
 */
interface WorkToolSpec {
	title: string;
	/**
	 * What the row's detail is: the `title` a creation was given, the work the
	 * call acted on, the first line of a comment's new text, the `work_type` a
	 * role listing is narrowed to, the role id read — or nothing.
	 */
	detail: "given" | "work" | "comment" | "workType" | "role" | "none";
	/** The argument naming the work the call acts on. */
	target?: "id" | "work_id" | "story_id";
	/** The kind the tool's name fixes, where it fixes one. */
	kind?: WorkType;
	/** The summary verbs ranked above `other`; every other work tool is one. */
	verb?: "create" | "start";
}

const WORK_TOOLS: Record<string, WorkToolSpec> = {
	story_create: {
		title: "Create story",
		detail: "given",
		kind: "story",
		verb: "create",
	},
	task_create: {
		title: "Create task",
		detail: "given",
		kind: "task",
		verb: "create",
	},
	story_start: {
		title: "Start story",
		detail: "work",
		target: "id",
		kind: "story",
		verb: "start",
	},
	task_start: {
		title: "Start task",
		detail: "work",
		target: "id",
		kind: "task",
		verb: "start",
	},
	work_reopen: { title: "Reopen", detail: "work", target: "id" },
	work_update: { title: "Update", detail: "work", target: "id" },
	work_delete: { title: "Delete", detail: "work", target: "id" },
	story_wait: {
		title: "Wait for tasks",
		detail: "work",
		target: "id",
		kind: "story",
	},
	story_unwatch: {
		title: "Unwatch",
		detail: "work",
		target: "id",
		kind: "story",
	},
	step_done: { title: "Step done", detail: "work", target: "id" },
	work_comment_add: { title: "Comment", detail: "work", target: "work_id" },
	work_comment_update: { title: "Edit comment", detail: "comment" },
	work_get: { title: "Get work", detail: "work", target: "id" },
	work_comment_list: {
		title: "List comments",
		detail: "work",
		target: "work_id",
	},
	task_list: {
		title: "List tasks",
		detail: "work",
		target: "story_id",
		kind: "story",
	},
	story_list: { title: "List stories", detail: "none" },
	agent_role_list: { title: "List roles", detail: "workType" },
	agent_role_get: { title: "Get role", detail: "role" },
	agent_role_reset_defaults: { title: "Reset roles", detail: "none" },
};

export interface WorkTool extends WorkToolSpec {
	/** The bare tool name: `task_create`. */
	tool: string;
}

/** The work tool a call is, by either name it arrives under (`pockodeTool`), or null. */
export function pockodeWorkTool(toolName: string): WorkTool | null {
	const tool = pockodeTool(toolName);
	// Own keys only: `constructor` is no work tool.
	return tool !== null && Object.hasOwn(WORK_TOOLS, tool)
		? { ...WORK_TOOLS[tool], tool }
		: null;
}

function asObject(input: unknown): Record<string, unknown> {
	return input && typeof input === "object"
		? (input as Record<string, unknown>)
		: {};
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The id the input names the work by, empty when it names none. */
function targetId(tool: WorkTool, input: unknown): string {
	return tool.target ? str(asObject(input)[tool.target]) : "";
}

/**
 * The row's detail. The work's title is the one its `workRef` carries — what
 * the work was called when the call was made — and never the work store's: a
 * record that retitled itself would be lying about what it was. Before the
 * result has brought one, or on a record without one, it is the input's id,
 * in mono.
 */
export function workToolDetail(
	tool: WorkTool,
	input: unknown,
	workRef: WorkRef | undefined,
): { detail: string; mono: boolean } {
	const obj = asObject(input);
	switch (tool.detail) {
		case "given":
			return { detail: str(obj.title), mono: false };
		case "work":
			return workRef?.title
				? { detail: workRef.title, mono: false }
				: { detail: targetId(tool, input), mono: true };
		case "comment":
			return { detail: firstLine(str(obj.body)), mono: false };
		case "workType":
			return { detail: str(obj.work_type), mono: false };
		case "role":
			return { detail: str(obj.id), mono: true };
		case "none":
			return { detail: "", mono: false };
	}
}

const KIND_WORDS: Record<WorkType, string> = {
	story: "Story",
	task: "Task",
	job: "Job",
};

/** `Task`, `Story`, `Job`: how the body's work line names the kind. */
export function workKindWord(kind: WorkType | undefined): string {
	return kind ? KIND_WORDS[kind] : "Work";
}

/**
 * The work a call's body opens on: its kind, its title as of the call, and
 * the id *Open* leads to — absent when there is none to offer. Null for a call
 * that acts on no work (a listing of every story, a role, a comment edit).
 *
 * *Open* is offered only on a call that succeeded and did not delete the work:
 * a failed call's id may name nothing, and an overlay that opens on *not
 * found* is a dead end the row put there. A record from before `work_ref`
 * existed opens by the input's id; an old creation names its work only in its
 * result prose, and is left without.
 */
export function workToolTarget(
	tool: WorkTool,
	input: unknown,
	workRef: WorkRef | undefined,
	succeeded: boolean,
): {
	kind: WorkType | undefined;
	title: string;
	mono: boolean;
	openId?: string;
} | null {
	if (!tool.target && tool.verb !== "create") return null;
	const id = workRef?.id ?? targetId(tool, input);
	const kind = workRef?.type ?? tool.kind;
	// The row's own detail, except that a creation's line names it by the
	// work's title rather than by an id the input does not have.
	const { detail, mono } =
		tool.verb === "create"
			? { detail: workRef?.title || str(asObject(input).title), mono: false }
			: workRef?.title
				? { detail: workRef.title, mono: false }
				: { detail: id, mono: true };
	const openable = succeeded && tool.tool !== "work_delete" && id !== "";
	return { kind, title: detail, mono, ...(openable ? { openId: id } : {}) };
}

/**
 * How a call reads in a group summary. A creation is named by its kind and the
 * title it was given; a start by its kind and the title its `workRef` carries,
 * and by nothing while it runs. Every other work tool is `other`, named by its
 * row's title.
 */
export function workToolVerb(
	tool: WorkTool,
	input: unknown,
	workRef: WorkRef | undefined,
): { verb: "create" | "start" | "other"; name?: string; kind?: WorkType } {
	if (tool.verb === "create") {
		const title = str(asObject(input).title);
		return {
			verb: "create",
			kind: tool.kind,
			...(title ? { name: `${tool.kind} "${title}"` } : {}),
		};
	}
	if (tool.verb === "start") {
		return {
			verb: "start",
			kind: tool.kind,
			...(workRef?.title ? { name: `${tool.kind} "${workRef.title}"` } : {}),
		};
	}
	return { verb: "other", name: tool.title };
}
