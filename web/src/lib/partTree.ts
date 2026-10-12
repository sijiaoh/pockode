import type { ContentPart } from "../types/message";
import { isHtmlRenderCard } from "./htmlRender";

/**
 * A message's content is a tree, not a list: a subagent call holds its own
 * text and calls as `tool.children`, and a child that is itself a subagent call
 * holds children of its own (docs/tool-call-model.md#a-subagents-own-conversation).
 *
 * These are the walks every reader of that tree needs, so that a rule written
 * against "the part with this id" or "every pending card" reaches a subagent's
 * work as surely as the main conversation's, and none of them has to remember
 * the recursion itself.
 */

/** Where a part sits: an index per level, outermost first. */
export type PartPath = number[];

/**
 * The path to the newest part `match` accepts, or null.
 *
 * Newest is read backwards through each list, and a run's children before the
 * run itself: they arrived after it. For a match that can only be one part —
 * a `tool_use_id` — the order is merely how far the walk goes.
 */
export function findPartPath(
	parts: ContentPart[],
	match: (part: ContentPart) => boolean,
): PartPath | null {
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		if (part.type === "tool_call" && part.tool.children) {
			const inner = findPartPath(part.tool.children, match);
			if (inner) return [i, ...inner];
		}
		if (match(part)) return [i];
	}
	return null;
}

/** The path to the run with this `tool_use_id`, at any depth, or null. */
export function findToolRunPath(
	parts: ContentPart[],
	toolUseId: string,
): PartPath | null {
	return findPartPath(
		parts,
		(part) => part.type === "tool_call" && part.tool.id === toolUseId,
	);
}

/**
 * Rewrites the list the part at `path` sits in. `edit` is handed that list and
 * the part's index in it, and returns the list to put back; every list above
 * it is copied on the way out, and nothing beside it is touched.
 */
export function editAtPath(
	parts: ContentPart[],
	path: PartPath,
	edit: (list: ContentPart[], index: number) => ContentPart[],
): ContentPart[] {
	const [index, ...rest] = path;
	if (rest.length === 0) return edit(parts, index);
	const part = parts[index];
	if (part?.type !== "tool_call") return parts; // A path from findPartPath never does this
	const updated = [...parts];
	updated[index] = {
		...part,
		tool: {
			...part.tool,
			children: editAtPath(part.tool.children ?? [], rest, edit),
		},
	};
	return updated;
}

/** Rewrites the children of the run at `path`. */
export function editChildrenAtPath(
	parts: ContentPart[],
	path: PartPath,
	edit: (children: ContentPart[]) => ContentPart[],
): ContentPart[] {
	return editAtPath(parts, path, (list, index) => {
		const part = list[index];
		if (part.type !== "tool_call") return list;
		const updated = [...list];
		updated[index] = {
			...part,
			tool: { ...part.tool, children: edit(part.tool.children ?? []) },
		};
		return updated;
	});
}

/**
 * `fn` applied to every part at every depth, children before the run that
 * holds them. Hands back the same list when `fn` changed nothing, so a
 * transcript nothing happened to does not re-render.
 */
export function mapPartsDeep(
	parts: ContentPart[],
	fn: (part: ContentPart) => ContentPart,
): ContentPart[] {
	let changed = false;
	const updated = parts.map((part) => {
		let next = part;
		if (part.type === "tool_call" && part.tool.children) {
			const children = mapPartsDeep(part.tool.children, fn);
			if (children !== part.tool.children) {
				next = { ...part, tool: { ...part.tool, children } };
			}
		}
		next = fn(next);
		if (next !== part) changed = true;
		return next;
	});
	return changed ? updated : parts;
}

/** Whether any part at any depth satisfies `match`. */
export function somePartDeep(
	parts: ContentPart[],
	match: (part: ContentPart) => boolean,
): boolean {
	return findPartPath(parts, match) !== null;
}

/** Every part at any depth that `match` accepts, in transcript order (depth-first). */
export function collectPartsDeep(
	parts: ContentPart[],
	match: (part: ContentPart) => boolean,
): ContentPart[] {
	const found: ContentPart[] = [];
	for (const part of parts) {
		if (match(part)) found.push(part);
		if (part.type === "tool_call" && part.tool.children) {
			found.push(...collectPartsDeep(part.tool.children, match));
		}
	}
	return found;
}

let partsMinted = 0;

/**
 * A new part's `id`, or a thought's. Fixed-width, so that comparing two as strings compares
 * when they were minted — which is what {@link oldestPart} reads.
 */
export function newPartId(): string {
	partsMinted += 1;
	return partsMinted.toString(36).padStart(10, "0");
}

/**
 * The item whose part was minted first: the one that has been on screen
 * longest. A list or a group of rows is named after it rather than after its
 * first member, because rows are added at both ends — a live call after the
 * last, and a history page joining from above in front of the first — and
 * the oldest member is the one neither displaces. Nor does a card, which keeps
 * the id of the row whose place it took. Only a member leaving the list, such
 * as a call whose page is drawn on its own once it succeeds, renames it.
 */
export function oldestPart<T extends { part: ContentPart }>(items: T[]): T {
	return items.reduce((oldest, item) =>
		item.part.id < oldest.part.id ? item : oldest,
	);
}

/**
 * Whether a part is drawn as a row: a tool call (a subagent call included), a
 * permission card whatever its state, or a thinking. Everything else — text, a
 * question card, a notice, a page an `html_render` call drew — is drawn as
 * itself. That call is a row until it succeeds: the page is the reply, not a
 * line in the tool log.
 */
export function isRowPart(part: ContentPart): boolean {
	return (
		(part.type === "tool_call" && !isHtmlRenderCard(part)) ||
		part.type === "permission_request" ||
		part.type === "thinking"
	);
}

export type PartBlock<T> =
	| { kind: "rows"; items: T[] }
	| { kind: "single"; item: T };

/**
 * A list of parts cut into what the transcript draws: each maximal run of
 * consecutive rows becomes one list, and every other part stands alone
 * (docs/tool-call-ui.md#the-list).
 */
export function partBlocks<T extends { part: ContentPart }>(
	items: T[],
): PartBlock<T>[] {
	const blocks: PartBlock<T>[] = [];
	for (const item of items) {
		if (!isRowPart(item.part)) {
			blocks.push({ kind: "single", item });
			continue;
		}
		const last = blocks.at(-1);
		if (last?.kind === "rows") last.items.push(item);
		else blocks.push({ kind: "rows", items: [item] });
	}
	return blocks;
}
