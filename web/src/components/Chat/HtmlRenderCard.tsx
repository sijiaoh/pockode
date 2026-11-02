import { AppWindow, Code, Maximize2, TriangleAlert } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useHtmlPage } from "../../hooks/useHtmlPage";
import { useInView } from "../../hooks/useInView";
import {
	FULL_SCREEN_OPENER_ATTR,
	type FullScreenSource,
} from "../../lib/fullScreen";
import {
	htmlEditInput,
	htmlRenderInput,
	isHtmlEditTool,
} from "../../lib/htmlRender";
import { outputLineCount } from "../../lib/textLines";
import type { ToolRun } from "../../types/message";
import { errorMessage } from "../../utils/errorMessage";
import {
	BlockHeader,
	ClampedContent,
	headerButtonClass,
	TEXT_BUTTON,
	TRANSCRIPT_HEIGHT_VAR,
} from "../ui";
import { CodeBlock } from "../ui/CodeBlock";
import { useFullScreen } from "./FullScreenHost";
import { HtmlFrame } from "./HtmlFrame";
import { useTranscriptView } from "./transcriptViewContext";

/**
 * Inline, a page takes at most this share of the transcript and scrolls inside
 * itself past it; full screen is the way to read the rest. A frame cannot be
 * clipped and opened in place as other blocks are: opening it would put a page
 * of any height into the transcript.
 */
const CAP = `calc(var(${TRANSCRIPT_HEIGHT_VAR}, 100svh) * 0.7)`;
const MIN_HEIGHT = 48;
const PLACEHOLDER_HEIGHT = 160;

/**
 * Each page's last measured height, kept across remounts — a session left and
 * reopened — so its placeholder holds the page's place and the transcript does
 * not jump as frames mount.
 */
const measuredHeights = new Map<string, number>();

/**
 * A successful `html_render` or `html_edit` call: the page the agent wrote for
 * the user, drawn as part of the reply rather than as a row
 * (docs/tool-call-ui.md).
 *
 * A render's input is its page. An edit's holds only the edits, so its page is
 * read from the server by the id its result carries — once, since a page never
 * changes — and the card that drew the page it started from stays as it was.
 */
export function HtmlRenderCard({
	run,
	sessionId,
}: {
	run: ToolRun;
	/** The session the page was stored under, for an edit's to be read. */
	sessionId: string;
}) {
	const edit = isHtmlEditTool(run.name);
	const pageId = run.htmlPage;
	const view = useTranscriptView();
	const [showSource, setShowSource] = useState(false);
	// Mounted once near the viewport and never unmounted after: a long session
	// does not run every old page at once, and a page the user has used keeps
	// its state. An edit's page is not even read before then.
	const { ref: inViewRef, inView } = useInView<HTMLDivElement>();
	const stored = useHtmlPage(
		sessionId,
		pageId ?? "",
		edit && !!pageId && inView,
	);
	const { title, html, base } = useMemo(() => {
		if (!edit) return { ...htmlRenderInput(run.input), base: undefined };
		const asked = htmlEditInput(run.input);
		// Undefined html is a page not here yet: an empty page is still a page.
		return stored.data
			? {
					title: stored.data.title,
					html: stored.data.html,
					base: stored.data.base ?? asked.base,
				}
			: { title: asked.title, html: undefined, base: asked.base };
	}, [edit, run.input, stored.data]);
	// A retry in flight is loading again, not still failed.
	const failed = edit && !stored.data && stored.isError && !stored.isFetching;
	const name =
		title ||
		(html !== undefined
			? "Untitled page"
			: failed
				? "Page not loaded"
				: "Loading page…");
	const [height, setHeight] = useState(() => measuredHeights.get(run.id));
	const [cut, setCut] = useState(false);
	const boxRef = useRef<HTMLDivElement>(null);

	const onHeight = useCallback(
		(reported: number) => {
			// Zero is a frame not laid out — hidden under the source view — or a
			// page blank for a moment; neither is the page's height.
			if (reported <= 0) return;
			const next = Math.max(MIN_HEIGHT, reported);
			measuredHeights.set(run.id, next);
			setHeight(next);
		},
		[run.id],
	);

	// Cut when the cap holds the box below the page's height. Watched rather
	// than computed, because the cap moves with the transcript's height.
	// biome-ignore lint/correctness/useExhaustiveDependencies: inView mounts the box to watch
	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box || height === undefined) {
			setCut(false);
			return;
		}
		const measure = () => setCut(box.clientHeight + 1 < height);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		return () => observer.disconnect();
	}, [height, inView]);

	const boxHeight = `min(${height ?? PLACEHOLDER_HEIGHT}px, ${CAP})`;
	const fullScreenKey = `${run.id}:page`;
	const source = useMemo<FullScreenSource | undefined>(
		() =>
			html === undefined
				? undefined
				: {
						title: name,
						label: "Page",
						noun: "page",
						from: "start",
						copyText: html,
						content: { kind: "html", html, showSource, pageKey: run.id },
					},
		[name, html, showSource, run.id],
	);
	const openFullScreen = useFullScreen(fullScreenKey, source);
	const opener = openFullScreen && {
		onClick: openFullScreen,
		"aria-haspopup": "dialog" as const,
		[FULL_SCREEN_OPENER_ATTR]: fullScreenKey,
	};

	return (
		<section
			aria-label={name}
			className="overflow-clip rounded-lg border border-th-border text-xs"
		>
			<div className="flex min-h-9 items-center gap-1.5 border-b border-th-border px-2 py-1.5 pointer-coarse:min-h-11 pointer-coarse:gap-2 sm:px-2.5">
				<AppWindow
					className="size-3 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1">
					<BlockHeader
						label={
							<>
								<span className="truncate font-medium text-th-text-primary">
									{name}
								</span>
								{/* The id is how the agent is asked about a page — "change
								    p3" — so it is shown where the reader can read it off. */}
								{pageId && (
									<span className="ml-1.5 shrink-0 font-mono">
										{base ? `${pageId} · from ${base}` : pageId}
									</span>
								)}
							</>
						}
						actions={
							html !== undefined && (
								<>
									<button
										type="button"
										aria-label="Show source"
										aria-pressed={showSource}
										onClick={() => setShowSource(!showSource)}
										className={headerButtonClass("sm", showSource)}
									>
										<Code size={14} aria-hidden="true" />
									</button>
									{/* Always offered, and last: a card is never the best
									    place to read a page. */}
									{opener && (
										<button
											type="button"
											aria-label="Open page in full screen"
											{...opener}
											className={headerButtonClass()}
										>
											<Maximize2 size={14} aria-hidden="true" />
										</button>
									)}
								</>
							)
						}
					/>
				</div>
			</div>
			{/* Hidden rather than unmounted under the source, so the page keeps
			    its state and its scripts do not run again. The strip of hosts it
			    was refused goes with it: the source has nothing to load. */}
			<div ref={inViewRef} hidden={showSource}>
				{failed ? (
					<div
						role="alert"
						className="flex items-center gap-2 px-2 py-2 sm:px-2.5"
					>
						<TriangleAlert
							className="size-3.5 shrink-0 text-th-error"
							aria-hidden="true"
						/>
						<span className="min-w-0 flex-1 break-words text-th-text-secondary">
							Couldn't load page {pageId}: {errorMessage(stored.error)}
						</span>
						<button
							type="button"
							onClick={() => stored.refetch()}
							className={TEXT_BUTTON}
						>
							Retry
						</button>
					</div>
				) : inView && html !== undefined ? (
					<HtmlFrame
						html={html}
						title={name}
						pageKey={run.id}
						onHeight={onHeight}
						shown={!showSource}
						boxRef={boxRef}
						boxStyle={{ height: boxHeight }}
					/>
				) : (
					// Grey rather than white: an unloaded white block glares in the
					// dark theme, where grey reads as "not here yet".
					<div
						aria-busy="true"
						className="flex items-center justify-center bg-th-bg-secondary"
						style={{ height: boxHeight }}
					>
						<AppWindow
							className="size-5 text-th-text-muted"
							aria-hidden="true"
						/>
					</div>
				)}
				{/* The frame's own scrollbar is invisible on a phone, so the cut
				    says itself here. */}
				{cut && opener && (
					<div className="flex border-t border-th-border px-1 py-1 pointer-coarse:py-1.5">
						<button
							type="button"
							aria-label="Open page in full screen"
							{...opener}
							className={`flex items-center gap-1 ${TEXT_BUTTON}`}
						>
							<Maximize2 className="size-3" aria-hidden="true" />
							Full screen
						</button>
					</div>
				)}
			</div>
			{showSource && html !== undefined && (
				<div className="p-2 sm:p-2.5">
					<ClampedContent
						budget="main"
						name="source"
						view={view}
						count={{ noun: "line", total: outputLineCount(html) }}
					>
						<CodeBlock code={html} language="html" />
					</ClampedContent>
				</div>
			)}
		</section>
	);
}
