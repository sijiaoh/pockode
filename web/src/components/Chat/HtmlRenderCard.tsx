import { AppWindow, Code, Maximize2 } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInView } from "../../hooks/useInView";
import {
	FULL_SCREEN_OPENER_ATTR,
	type FullScreenSource,
} from "../../lib/fullScreen";
import { htmlRenderInput } from "../../lib/htmlRender";
import { outputLineCount } from "../../lib/textLines";
import type { ToolRun } from "../../types/message";
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
 * A successful `html_render` call: the page the agent wrote for the user, drawn
 * as part of the reply rather than as a row (docs/tool-call-ui.md).
 */
export function HtmlRenderCard({ run }: { run: ToolRun }) {
	const { title, html } = useMemo(
		() => htmlRenderInput(run.input),
		[run.input],
	);
	const name = title || "Untitled page";
	const view = useTranscriptView();
	const [showSource, setShowSource] = useState(false);
	// Mounted once near the viewport and never unmounted after: a long session
	// does not run every old page at once, and a page the user has used keeps
	// its state.
	const { ref: inViewRef, inView } = useInView<HTMLDivElement>();
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
	const source = useMemo<FullScreenSource>(
		() => ({
			title: name,
			label: "Page",
			noun: "page",
			from: "start",
			copyText: html,
			content: { kind: "html", html, showSource },
		}),
		[name, html, showSource],
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
							<span className="truncate font-medium text-th-text-primary">
								{name}
							</span>
						}
						actions={
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
								{/* Always offered, and last: a card is never the best place
								    to read a page. */}
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
						}
					/>
				</div>
			</div>
			{/* Hidden rather than unmounted under the source, so the page keeps
			    its state and its scripts do not run again. */}
			<div ref={inViewRef} hidden={showSource}>
				{inView ? (
					<div ref={boxRef} style={{ height: boxHeight }}>
						<HtmlFrame
							html={html}
							title={name}
							onHeight={onHeight}
							className="h-full"
						/>
					</div>
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
			{showSource && (
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
