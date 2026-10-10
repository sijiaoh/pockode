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

/**
 * A part's React key within its list: one part per call, because a
 * permission card takes its call's place and a resent `tool_call` updates the
 * row it names rather than adding one — so a row keys on its tool use id, a
 * card on its request id, a thinking on the id the reducer gave it, and only
 * parts with none of these fall back to position.
 */
export function partKey(part: ContentPart, index: number): string {
	switch (part.type) {
		case "permission_request":
			return part.request.requestId;
		case "question_record":
			// Not unique on its own for a legacy record, which could carry several
			// questions under one request id; the index disambiguates those.
			return `${part.record.requestId}-${index}`;
		case "tool_call":
			return part.tool.id;
		case "thinking":
			return part.id;
		default:
			return `${part.type}-${index}`;
	}
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
