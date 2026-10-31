import { ChevronRight, MousePointerClick } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
	FULL_SCREEN_OPENER_ATTR,
	type FullScreenSource,
} from "../../lib/fullScreen";
import type { CanvasAction } from "../../types/canvas";
import { DiscardedNote } from "./DiscardedMessage";
import { useFullScreen } from "./FullScreenHost";

/**
 * How long the data may be, as one line of JSON, before it is folded: about
 * what a phone's bubble holds on one line of `text-sm`. Counted rather than
 * measured, so a bubble does not change shape as it is first laid out.
 */
const DATA_LINE_CHARS = 40;

/**
 * How much of the folded line is put in the page at all: enough to fill a
 * desktop's bubble before it is cut, never the whole of data that may be 64KB
 * laid out on one line to show forty characters of it.
 */
const FOLDED_PREVIEW_CHARS = DATA_LINE_CHARS * 4;

/**
 * How much of the indented data opens in the bubble — lines, and characters
 * for data that is one long string — the rest being read in the full screen
 * viewer. The bubble has no clamp of its own to cut it with: the transcript's
 * clamp draws its button and its fade in colours made for the page, not for
 * the bubble.
 */
const OPEN_DATA_LINES = 20;
const OPEN_DATA_CHARS = 2000;

/** The data as it is drawn: absent when the page sent none (`{}`). */
function dataText(data: unknown): string | null {
	if (
		data !== null &&
		typeof data === "object" &&
		!Array.isArray(data) &&
		Object.keys(data).length === 0
	) {
		return null;
	}
	return JSON.stringify(data);
}

/**
 * What the user did on a canvas page, drawn from the structured copy the
 * record carries — never from `content`, which is the action written out for
 * the agent and arrives only with the server's reply (docs/canvas-ui.md §12).
 * A bubble, because it is the user's own turn; of its own kind, because they
 * pressed something rather than wrote it.
 */
export function CanvasActionBubble({
	id,
	canvasAction,
	discarded,
	className = "",
}: {
	/** The message's, naming its data in full screen. */
	id: string;
	canvasAction: CanvasAction;
	discarded?: boolean;
	/** The UI config's user bubble class, as the typed bubble takes it. */
	className?: string;
}) {
	const [unfolded, setUnfolded] = useState(false);
	const dataId = useId();
	const data = useMemo(() => dataText(canvasAction.data), [canvasAction.data]);
	const folds = data !== null && data.length > DATA_LINE_CHARS;

	return (
		<div
			className={`chat-bubble max-w-full min-w-0 overflow-hidden rounded-lg bg-th-user-bubble p-2.5 text-th-user-bubble-text sm:p-3 ${className}`}
		>
			{/* The meta in the bubble's own colour, smaller rather than fainter:
			    the pair is held to AA by `contrast.test.ts` with no room for an
			    opacity (see AnsweringBody). */}
			<p className="flex flex-wrap items-baseline gap-x-2">
				<span className="flex min-w-0 items-center gap-1.5 font-medium">
					<MousePointerClick
						className="size-3.5 shrink-0 self-center"
						aria-hidden="true"
					/>
					{/* The glyph is what says it was pressed, not typed. */}
					<span className="sr-only">Canvas action </span>
					<span className="break-all">{canvasAction.action}</span>
				</span>
				<span className="text-xs">from revision {canvasAction.revision}</span>
			</p>
			{data !== null &&
				(folds ? (
					<>
						<button
							type="button"
							aria-expanded={unfolded}
							aria-controls={unfolded ? dataId : undefined}
							onClick={() => setUnfolded(!unfolded)}
							className="touch-target mt-1 flex w-full min-w-0 items-center gap-1 text-left text-xs"
						>
							<ChevronRight
								className={`size-3 shrink-0 transition-transform ${unfolded ? "rotate-90" : ""}`}
								aria-hidden="true"
							/>
							<span className="sr-only">Data </span>
							{!unfolded && (
								<span className="min-w-0 truncate font-mono">
									{data.slice(0, FOLDED_PREVIEW_CHARS)}
								</span>
							)}
						</button>
						{unfolded && (
							<OpenData
								id={dataId}
								fullScreenKey={`canvas-action:${id}`}
								title={canvasAction.action}
								data={canvasAction.data}
							/>
						)}
					</>
				) : (
					<p className="mt-1 break-words font-mono text-xs">{data}</p>
				))}
			{discarded && <DiscardedNote className="mt-2" />}
		</div>
	);
}

function OpenData({
	id,
	fullScreenKey,
	title,
	data,
}: {
	id: string;
	fullScreenKey: string;
	title: string;
	data: unknown;
}) {
	const text = useMemo(() => JSON.stringify(data, null, 2), [data]);
	const opening = useMemo(
		() =>
			text.split("\n", OPEN_DATA_LINES).join("\n").slice(0, OPEN_DATA_CHARS),
		[text],
	);
	const cut = opening.length < text.length;
	const source = useMemo<FullScreenSource | undefined>(
		() =>
			cut
				? {
						title,
						label: "Data",
						noun: "data",
						from: "start",
						copyText: text,
						content: { kind: "output", text },
					}
				: undefined,
		[cut, text, title],
	);
	const openFullScreen = useFullScreen(fullScreenKey, source);
	// Without a viewer to read the rest in, the bubble holds all of it.
	const shown = cut && openFullScreen ? `${opening}…` : text;

	return (
		<div id={id}>
			<pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">
				{shown}
			</pre>
			{cut && openFullScreen && (
				<button
					type="button"
					onClick={openFullScreen}
					aria-haspopup="dialog"
					{...{ [FULL_SCREEN_OPENER_ATTR]: fullScreenKey }}
					className="touch-target mt-1 text-xs underline"
				>
					Show all data
				</button>
			)}
		</div>
	);
}
