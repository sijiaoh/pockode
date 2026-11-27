import { Fragment, type ReactNode } from "react";
import { formatElapsed, spokenElapsed } from "../../lib/toolRun";
import type { TurnWork } from "../../lib/turnWork";

export const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

/** A settled reply's work figures, and how many files it changed. */
export interface WorkFiguresProps {
	work: TurnWork;
	files: number;
}

/**
 * The figures as a sentence, at every width: *"Worked 2 minutes 13 seconds, 6
 * tool calls, 2 files changed"*.
 */
export function spokenWorkFigures({ work, files }: WorkFiguresProps): string {
	return [
		work.durationMs !== undefined && `Worked ${spokenElapsed(work.durationMs)}`,
		work.calls !== undefined && plural(work.calls, "tool call"),
		files > 0 && `${plural(files, "file")} changed`,
	]
		.filter(Boolean)
		.join(", ");
}

/**
 * The figures' visible words (docs/tool-call-ui.md#the-work-figures). Below the
 * `work-line` container width the nouns shorten — `14 calls`, `3 files` —
 * rather than the end being cut, which would cut the file count of a card
 * about files. The container is the caller's: the card header or the turn-end
 * row. A files entry standing alone is never shortened: shortening is there
 * to fit three entries, and `2 files` alone reads as a fragment.
 */
export function WorkFiguresWords({ work, files }: WorkFiguresProps) {
	const wide = (words: string) => (
		<span className="hidden @work-line:inline">{words}</span>
	);
	const entries: { key: string; node: ReactNode }[] = [];
	if (work.durationMs !== undefined) {
		entries.push({
			key: "time",
			node: (
				<span className="tabular-nums">
					Worked {formatElapsed(work.durationMs)}
				</span>
			),
		});
	}
	if (work.calls !== undefined) {
		entries.push({
			key: "calls",
			node: (
				<>
					{work.calls} {wide("tool ")}
					{work.calls === 1 ? "call" : "calls"}
				</>
			),
		});
	}
	if (files > 0) {
		const noun = files === 1 ? "file" : "files";
		entries.push({
			key: "files",
			node:
				entries.length === 0 ? (
					`${files} ${noun} changed`
				) : (
					<>
						{files} {noun}
						{wide(" changed")}
					</>
				),
		});
	}
	return entries.map(({ key, node }, index) => (
		<Fragment key={key}>
			{index > 0 && <span className="text-th-text-muted"> · </span>}
			{node}
		</Fragment>
	));
}
