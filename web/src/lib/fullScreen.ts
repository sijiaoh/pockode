import type { ReactNode } from "react";
import type { ProposedChangeData } from "./proposedChange";
import { getLanguageFromPath, isMarkdownFile } from "./shikiUtils";

/**
 * What the full screen viewer draws, by what it is read as. The viewer draws
 * it itself rather than being handed the transcript's rendering, because it
 * draws it differently: unclamped, with its own wrap, and — for content that
 * changes as it is read — from the latest text rather than a snapshot.
 */
export type FullScreenContent =
	| {
			kind: "output";
			text: string;
			/** A failed command, whose last lines say why. */
			failedTail?: boolean;
			/**
			 * Still arriving; `droppedLines` is how many first lines the reducer
			 * has dropped from it so far.
			 */
			live?: { droppedLines: number };
			/**
			 * The text of a result that also holds what only the transcript draws
			 * — images, files, tool names — between its pieces of text.
			 */
			withAttachments?: boolean;
	  }
	| { kind: "code"; text: string; language?: string }
	| { kind: "markdown"; markdown: string }
	/**
	 * An agent's page (`html_render`), rendered or — `showSource` — read as its
	 * code; the viewer switches between the two, opening on the card's choice.
	 */
	| { kind: "html"; html: string; showSource: boolean }
	/** Drawn by `ProposedChange`: an edit's or a Codex change's diffs, never a Write. */
	| { kind: "change"; change: ProposedChangeData }
	/** Every path, not the transcript's first hundred. */
	| { kind: "files"; paths: string[]; onOpenFile?: (path: string) => void };

/**
 * What a tool acted on, shown in full under the viewer's title: the title is
 * cut to a few words on a phone, and this gets the whole width.
 */
export type FullScreenSubject =
	| { kind: "path"; path: string }
	| { kind: "text"; text: string };

/**
 * One block's view in full screen, published by the block for as long as it is
 * mounted (docs/tool-call-ui.md#full-screen).
 */
export interface FullScreenSource {
	/** The tool summary — `Bash · pnpm test` — or the block's own name. */
	title: string;
	subject?: FullScreenSubject;
	/** The block's label, heading the viewer's toolbar as it heads the block. */
	label: string;
	/** What the block holds, lowercased, for the viewer's accessible names. */
	noun: string;
	/** Which end is read first; the viewer opens there. */
	from: "start" | "end";
	/** What the toolbar's copy button copies; no button without it. */
	copyText?: string | (() => string);
	/** The block header's meta: a change's `+N −M`, `not applied`. */
	meta?: ReactNode;
	content: FullScreenContent;
}

/**
 * Marks the control that opens a key, for focus to come back to when the
 * control that opened the viewer has gone.
 */
export const FULL_SCREEN_OPENER_ATTR = "data-full-screen-opener";

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

/** What the tool acted on, for the tools that act on one thing. */
export function fullScreenSubject(
	toolName: string,
	input: unknown,
): FullScreenSubject | undefined {
	const obj = (input && typeof input === "object" ? input : {}) as Record<
		string,
		unknown
	>;
	const text = (value: unknown): FullScreenSubject | undefined => {
		const s = str(value);
		return s ? { kind: "text", text: s } : undefined;
	};
	switch (toolName) {
		case "Bash":
			return text(obj.command);
		case "Read":
		case "Write":
		case "Edit":
		case "MultiEdit": {
			const path = str(obj.file_path);
			return path ? { kind: "path", path } : undefined;
		}
		case "Grep":
		case "Glob":
			return text(obj.pattern);
		case "WebFetch":
			return text(obj.url);
		case "WebSearch":
			return text(obj.query);
		default:
			return undefined;
	}
}

/** A whole file's text: Markdown rendered, as the transcript does, code highlighted. */
export function fileFullScreenContent(
	text: string,
	filePath?: string,
): FullScreenContent {
	if (filePath && isMarkdownFile(filePath)) {
		return { kind: "markdown", markdown: text };
	}
	return {
		kind: "code",
		text,
		language: filePath ? getLanguageFromPath(filePath) : undefined,
	};
}
