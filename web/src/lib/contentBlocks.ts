import type { ContentBlock, FileBlock } from "../types/content";
import type { OmitReason } from "../types/contents";

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value !== 0
		? value
		: undefined;
}

function asOmitReason(value: unknown): OmitReason | undefined {
	return value === "too_large" || value === "binary" || value === "unavailable"
		? value
		: undefined;
}

function parseFileBlock(raw: unknown): FileBlock | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	return {
		name: asString(r.name),
		// The one field with no sensible stand-in: an empty MIME means the agent
		// said nothing about the type, which the UI reads as "not an image".
		mime: typeof r.mime === "string" ? r.mime : "",
		size: asNumber(r.size),
		width: asNumber(r.width),
		height: asNumber(r.height),
		attachment_id: asString(r.attachment_id),
		path: asString(r.path),
		omitted: asOmitReason(r.omitted),
		limit: asNumber(r.limit),
	};
}

/**
 * Reads the `contents` of a `tool_result` record.
 *
 * Returns undefined for a result that carried none, which is every result
 * recorded before blocks existed and still the overwhelming majority: those
 * travel as prose in `tool_result` alone.
 *
 * A block whose type is unknown here, or that is missing what its type calls
 * for, is dropped rather than rendered as a blank — the server already passes
 * anything it does not recognise through as text, so a block arriving in a
 * shape this cannot read is a version mismatch, not content to guess at.
 */
export function parseContentBlocks(raw: unknown): ContentBlock[] | undefined {
	if (!Array.isArray(raw)) return undefined;

	const blocks: ContentBlock[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;

		switch (r.type) {
			case "text": {
				// An empty one is dropped rather than kept as a block with nothing
				// in it: the tool call offers a chevron exactly when there is a
				// body, and a blank block would make it open onto nothing.
				const text = asString(r.text);
				if (text) blocks.push({ type: "text", text });
				break;
			}
			case "file": {
				const file = parseFileBlock(r.file);
				if (file) blocks.push({ type: "file", file });
				break;
			}
			case "tool_reference": {
				const toolName = asString(r.tool_name);
				if (toolName) blocks.push({ type: "tool_reference", toolName });
				break;
			}
		}
	}

	return blocks.length > 0 ? blocks : undefined;
}

/** The prose in a result's blocks, joined as the agent laid it out. */
export function contentBlocksText(blocks: ContentBlock[]): string {
	return blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Enough of the call that produced a result to say which file it read. */
export interface ToolCallRef {
	name: string;
	input: unknown;
}

/**
 * The file a call's result *is* the content of, when there is such a file.
 *
 * Read only. Its contract is exactly that — the result is what is in
 * `file_path` — so naming the block after it states a fact. Other tools take a
 * `file_path` and answer with something else: a chart drawn from a CSV is not
 * the CSV, and labelling it so would offer to open the wrong file.
 */
function readFilePath(call: ToolCallRef): string | undefined {
	if (call.name !== "Read") return undefined;
	if (!call.input || typeof call.input !== "object") return undefined;
	const path = (call.input as Record<string, unknown>).file_path;
	return typeof path === "string" && path !== "" ? path : undefined;
}

/**
 * The file-like blocks, in order: what the attachment strip draws.
 *
 * `call` is the one that produced them, read for the file the agent left the
 * block without: an agent that hands over content inline says nothing about
 * where it came from — claude's image and document blocks carry bytes and no
 * path — yet a Read's `file_path` is exactly that file. Without it the same
 * image read by the two agents gets different offers: codex's names the file
 * and can open it in the Files tab, claude's is "PNG image" with no way over.
 *
 * Only a lone block is completed. One path cannot say which of several files it
 * belongs to, and a guess here would put the wrong name under an image.
 */
export function contentBlockFiles(
	blocks: ContentBlock[],
	call?: ToolCallRef,
): FileBlock[] {
	const files = blocks
		.filter((block) => block.type === "file")
		.map((block) => block.file);

	if (files.length !== 1 || files[0].path || !call) return files;
	const path = readFilePath(call);
	return path ? [{ ...files[0], path }] : files;
}

/**
 * A run of blocks that render as one thing: prose, or a list of tool names.
 * File blocks are not here — they are drawn in the attachment strip above the
 * body, where they are visible without expanding anything.
 */
export type ContentBlockGroup =
	| { kind: "text"; text: string }
	| { kind: "tools"; names: string[] };

/**
 * Collapses consecutive blocks of a kind into one group, keeping the agent's
 * order. Grouping rather than mapping one-to-one because the names a tool
 * search returns read as a list — one block per name, laid out as one row.
 */
export function groupContentBlocks(
	blocks: ContentBlock[],
): ContentBlockGroup[] {
	const groups: ContentBlockGroup[] = [];

	for (const block of blocks) {
		const last = groups[groups.length - 1];
		if (block.type === "text") {
			if (last?.kind === "text") last.text += `\n${block.text}`;
			else groups.push({ kind: "text", text: block.text });
		} else if (block.type === "tool_reference") {
			if (last?.kind === "tools") last.names.push(block.toolName);
			else groups.push({ kind: "tools", names: [block.toolName] });
		}
	}

	return groups;
}
