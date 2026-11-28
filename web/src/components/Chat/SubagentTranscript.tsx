import {
	CoverLayerContext,
	useCoverPage,
	useIsDrawnOver,
} from "@pockode/shared";
import { ArrowLeft, Bot, ChevronRight } from "lucide-react";
import {
	type Dispatch,
	type Ref,
	type SetStateAction,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	isLiveRun,
	resumedRun,
	subagentLastWords,
	subagentPath,
	withoutEchoedReport,
} from "../../lib/subagentRun";
import {
	subagentPossessive,
	taskPrompt,
	toolSummary,
} from "../../lib/toolSummary";
import { findLoadedRun } from "../../lib/transcriptMemo";
import type { Message, ToolRun } from "../../types/message";
import {
	ClampedContent,
	headerIconButtonClass,
	MarkdownContent,
	TRANSCRIPT_HEIGHT_VAR,
} from "../ui";
import { FullScreenHost } from "./FullScreenHost";
import { ContentPartItem, type ContentPartItemProps } from "./MessageItem";
import ScrollToBottomButton from "./ScrollToBottomButton";
import { FactsLine, SubagentConclusion } from "./SubagentConclusion";
import { anchorCandidateProps } from "./scrollAnchor";
import {
	SubagentResumesContext,
	useSubagentResume,
	useSubagentResumesValue,
} from "./subagentResumesContext";
import {
	openerOrSuccessor,
	SubagentTranscriptContext,
} from "./subagentTranscriptContext";
import { subagentHeader } from "./TaskItem";
import { PartBlocks } from "./ToolList";
import { Chip, Detail } from "./ToolRow";
import { findShown, useLanding } from "./transcriptJump";
import { TranscriptViewContext } from "./transcriptViewContext";
import { useTranscriptScroll } from "./useTranscriptScroll";

/** What the chat hands every part a level draws, as its own list does. */
export type LevelPartProps = Omit<
	ContentPartItemProps,
	"part" | "depth" | "asker" | "wideCards"
>;

/**
 * What the chat asks of the layer from outside it: the attention strip's jump
 * to a permission card lands in the level on screen when the card is there
 * (docs/subagent-transcript-ui.md#a-step-that-asks-the-user).
 */
export interface SubagentTranscriptHandle {
	/** Whether the card is drawn in the level on screen. */
	hasRequest: (requestId: string) => boolean;
	jumpToRequest: (requestId: string) => void;
}

interface Props {
	ref?: Ref<SubagentTranscriptHandle>;
	messages: Message[];
	/**
	 * The subagents shown, by their calls' `tool_use_id`, outermost first: one
	 * level each, the last one on screen. Never empty while the layer is drawn.
	 */
	path: string[];
	onPathChange: Dispatch<SetStateAction<string[]>>;
	/**
	 * Escape belongs to something drawn over the layer that does not register
	 * as a layer — the chat's answer panel, which claims it on the window,
	 * after this `document` listener.
	 */
	escapeHeld: boolean;
	partProps: LevelPartProps;
}

/**
 * The runs of the levels, down to the first whose run is gone: that level
 * closes, and every level above it.
 */
function levelRuns(messages: Message[], path: string[]): ToolRun[] {
	const runs: ToolRun[] = [];
	for (const id of path) {
		const run = findLoadedRun(messages, id);
		if (!run) break;
		runs.push(run);
	}
	return runs;
}

/** Marks each level's scroller with its place in the stack. */
const LEVEL_SCROLLER_ATTR = "data-subagent-level";

/**
 * A subagent's work as a transcript of its own, over the chat's
 * (docs/subagent-transcript-ui.md). Drawn in the transcript's rectangle and
 * not over the app, so the header, the attention strip, the answer panel and
 * the composer stay live; not portalled, so the chat's `CoveredSurface` and
 * `PageSendContext` reach it as they reach the list.
 *
 * Read from the loaded transcript on every render, never a copy of it: each
 * level follows its run as it streams, and closes — with every level above
 * it — once the run is no longer there.
 */
export function SubagentTranscript({
	ref,
	messages,
	path,
	onPathChange,
	escapeHeld,
	partProps,
}: Props) {
	const shown = levelRuns(messages, path);
	const kept = shown.length;
	const truncated = kept < path.length;
	useEffect(() => {
		if (truncated) onPathChange((current) => current.slice(0, kept));
	}, [truncated, kept, onPathChange]);

	// Derived from the whole transcript, as the chat's list derives them: a
	// row in a level reads the same facts its copy in the chat does.
	const resumes = useSubagentResumesValue(messages);

	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const goUp = useCallback(
		(depth: number) => onPathChange((current) => current.slice(0, depth)),
		[onPathChange],
	);
	// The ⤢ each level was gone down from, by the depth going up restores:
	// focus goes back to it. A level opened as part of a path has none, and
	// going up to it focuses its scroller.
	const openersRef = useRef<(HTMLElement | undefined)[]>([]);
	const descend = useCallback(
		(from: number, toolUseId: string, opener: HTMLElement) => {
			openersRef.current[from + 1] = opener;
			onPathChange((current) => {
				// The whole path down from this level, as from the chat: a ⤢ in
				// a nested row's inline Process can be more than one level down.
				const full = subagentPath(messagesRef.current, toolUseId);
				const at = full.indexOf(current[from]);
				return [
					...current.slice(0, from + 1),
					...(at === -1 ? [toolUseId] : full.slice(at + 1)),
				];
			});
		},
		[onPathChange],
	);

	const sectionRef = useRef<HTMLElement>(null);
	const depthRef = useRef(kept);
	useEffect(() => {
		const before = depthRef.current;
		const depth = kept;
		depthRef.current = depth;
		if (depth >= before || depth === 0) return;
		const opener = openersRef.current[depth];
		openersRef.current.length = depth;
		const scroller = sectionRef.current?.querySelector<HTMLElement>(
			`[${LEVEL_SCROLLER_ATTR}="${depth - 1}"]`,
		);
		const target = opener && openerOrSuccessor(opener, scroller);
		(target ?? scroller)?.focus({ preventScroll: true });
	}, [kept]);

	const top = shown.at(-1);
	if (!top) return null;
	const titles = shown.map((run) => toolSummary(run.name, run.input, "").title);
	return (
		<section
			ref={sectionRef}
			aria-label={`${subagentPossessive(titles[titles.length - 1])} transcript`}
			// Under the answer panel's z-10, which is raised over whatever the
			// transcript area shows.
			className="absolute inset-0 z-5 bg-th-bg-primary"
		>
			<SubagentResumesContext value={resumes}>
				{/* Levels are drawn as siblings, outermost first, never one
				    inside another: each registers a layer, and a child's
				    effect runs before its parent's, so nested levels opened in
				    one commit would push their history entries in the wrong
				    order (docs/subagent-transcript-ui.md#back-at-each-depth). */}
				{shown.map((run, index) => (
					<SubagentLevel
						key={run.id}
						index={index}
						onTop={index === kept - 1}
						handleRef={index === kept - 1 ? ref : undefined}
						run={run}
						titles={titles.slice(0, index + 1)}
						onGoUp={goUp}
						onDescend={descend}
						escapeHeld={escapeHeld}
						partProps={partProps}
					/>
				))}
			</SubagentResumesContext>
		</section>
	);
}

interface LevelProps {
	/** Its place in the stack: 0 is the one opened from the chat. */
	index: number;
	/** Whether this is the level on screen, the last of the stack. */
	onTop: boolean;
	/** Given to the level on screen only. */
	handleRef?: Ref<SubagentTranscriptHandle>;
	run: ToolRun;
	/** Every level's title down to this one: its breadcrumb. */
	titles: string[];
	/** Leaves this many levels up; 0 closes the layer. */
	onGoUp: (depth: number) => void;
	onDescend: (from: number, toolUseId: string, opener: HTMLElement) => void;
	escapeHeld: boolean;
	partProps: LevelPartProps;
}

function SubagentLevel({
	index,
	onTop,
	handleRef,
	run,
	titles,
	onGoUp,
	onDescend,
	escapeHeld,
	partProps,
}: LevelProps) {
	const title = titles[index];
	const goUp = useCallback(() => onGoUp(index), [onGoUp, index]);
	// One layer per level: each holds a history entry of its own, so Back goes
	// up one level (docs/project-ui.md#52-back-closes-the-topmost-layer).
	const layer = useCoverPage(true, { onBack: goUp });
	// Over a level below the top is the level above it, and over the top one a
	// sheet or a dialog opened from it — a block's full screen, the media
	// viewer — which takes Escape first: this listener may have been added
	// before theirs and so would run first.
	const drawnOver = useIsDrawnOver(layer);
	useEffect(() => {
		// Not left to `drawnOver` alone for a level below the top: opened as a
		// path in one commit, it runs this before the level above registers.
		if (!onTop || escapeHeld || drawnOver) return;
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			goUp();
		};
		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [onTop, escapeHeld, drawnOver, goUp]);
	const descend = useCallback(
		(toolUseId: string, opener: HTMLElement) =>
			onDescend(index, toolUseId, opener),
		[onDescend, index],
	);

	const prompt = taskPrompt(run.input);
	const { report, outcome } = subagentLastWords(run);
	const arrived = run.children ?? [];
	// Resumed, it is running again, as its row is.
	const resume = useSubagentResume(run.id);
	const live = isLiveRun(resumedRun(run, resume));

	const scrollRef = useRef<HTMLElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const conclusionRef = useRef<HTMLDivElement>(null);
	// The chat's own scroll machinery, on the level's parts
	// (docs/subagent-transcript-ui.md#following-the-live-tail). A live subagent
	// opens at its end, following it; a settled one at its prompt, since its
	// report is what the row's body already showed.
	const scroll = useTranscriptScroll({
		scrollRef,
		trackRef,
		contentRef,
		// The last child by identity — the reducer replaces it as it streams,
		// and only the path down to whatever changed — and what the end block
		// says.
		tail: [arrived.length, arrived.at(-1), report, outcome, live],
		startAt: live ? "end" : "top",
	});
	const {
		view,
		isFollowing,
		isAtEnd,
		jumpTo,
		readFrom,
		scrollToBottom,
		stopFollowing,
	} = scroll;

	// A level under the top one is off the screen and follows nothing: coming
	// back up finds it where it was left, with the dot if it grew — and one
	// left following that is still at its end follows on.
	const followsOnRef = useRef(false);
	useLayoutEffect(() => {
		if (!onTop) {
			followsOnRef.current = isFollowing();
			stopFollowing();
		} else if (followsOnRef.current) {
			followsOnRef.current = false;
			if (isAtEnd()) scrollToBottom();
		}
	}, [onTop, isFollowing, isAtEnd, stopFollowing, scrollToBottom]);

	// Settling while followed goes to the report's top, under the header, rather
	// than the end of a report that may be screens long, and follows no more;
	// a reader who scrolled away is not moved. Resumed, a view at the end follows
	// again — once back on top, for a level under another. After the hook's own
	// placing of this commit, which it declared first.
	const wasLiveRef = useRef(live);
	useLayoutEffect(() => {
		const wasLive = wasLiveRef.current;
		wasLiveRef.current = live;
		if (wasLive && !live) {
			const conclusion = conclusionRef.current;
			if (conclusion && isFollowing()) readFrom(conclusion);
		} else if (!wasLive && live && isAtEnd()) {
			if (onTop) scrollToBottom();
			else followsOnRef.current = true;
		}
	}, [live, onTop, isFollowing, isAtEnd, readFrom, scrollToBottom]);

	// The view's height, for the blocks whose budget is a share of it, as the
	// chat's list publishes its own: the level is not inside that list.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const publish = () =>
			el.style.setProperty(TRANSCRIPT_HEIGHT_VAR, `${el.clientHeight}px`);
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// The keyboard scrolls the level at once. Without scrolling: a settled
	// subagent opens on its prompt.
	useEffect(() => {
		scrollRef.current?.focus({ preventScroll: true });
	}, []);

	const land = useLanding(jumpTo);
	useImperativeHandle(handleRef, () => {
		const find = (requestId: string) =>
			scrollRef.current
				? findShown(scrollRef.current, "permissionRequestId", requestId)
				: null;
		return {
			hasRequest: (requestId) => find(requestId) !== null,
			jumpToRequest: (requestId) => {
				const card = find(requestId);
				if (card) land(card);
			},
		};
	}, [land]);

	// The report is drawn once, at the end, and not again as the last child.
	const children = withoutEchoedReport(arrived, report || outcome).map(
		(part) => ({ part }),
	);

	// A level below the top stays mounted, so coming back up to it finds it as
	// it was left. Invisible rather than `hidden`: a scroller taken out of
	// layout can lose its scroll position.
	return (
		<div
			inert={!onTop}
			className={`absolute inset-0 flex flex-col bg-th-bg-primary ${onTop ? "" : "invisible"}`}
		>
			<CoverLayerContext value={layer}>
				{/* A level is a transcript, so it has a viewer of its own: a block's
				    key is derived from its run, and the same run is drawn in the
				    chat under the layer too. */}
				<FullScreenHost>
					<LevelHeader run={run} titles={titles} onGoUp={onGoUp} />
					{/* A ⤢ in the level goes down from it. */}
					<SubagentTranscriptContext value={descend}>
						<TranscriptViewContext value={view}>
							{/* Browser scroll anchoring off, and the rows on the track's
							    bottom edge, as in the chat's list: the anchoring is
							    `useTranscriptScroll`'s. */}
							<section
								ref={scrollRef}
								data-subagent-level={index}
								// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroller the keyboard has to reach, and the focus target on open
								tabIndex={0}
								aria-label={`${subagentPossessive(title)} work`}
								className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none] focus:outline-none"
							>
								<div
									ref={trackRef}
									className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end px-3 sm:px-4"
								>
									{/* At least the view's height, so a short level reads from
									    the top rather than sitting on the bottom as a short chat
									    does. The padding is on this column, not the scroller: an
									    open row's bar pins to the scroller's padding edge. */}
									<div
										ref={contentRef}
										className="min-h-(--transcript-height) shrink-0 space-y-3 py-3 text-th-text-primary"
									>
										{prompt && (
											<div {...anchorCandidateProps} className="text-xs">
												<p className="pb-1 text-th-text-muted">Prompt</p>
												<div className="rounded-lg bg-th-bg-secondary p-2">
													<ClampedContent name="prompt" view={view}>
														<MarkdownContent content={prompt} variant="note" />
													</ClampedContent>
												</div>
											</div>
										)}
										{children.length > 0 && (
											<div className="space-y-2">
												{/* Drawn as the chat draws its top level: the
												    subagent's text as a message, no rail, and a nested
												    subagent's pending card in its row's slot by the
												    chat's own rule. */}
												<PartBlocks
													items={children}
													wrapperProps={anchorCandidateProps}
													renderPart={({ part }) => (
														<ContentPartItem part={part} {...partProps} />
													)}
												/>
											</div>
										)}
										<div
											ref={conclusionRef}
											{...anchorCandidateProps}
											className="text-xs"
										>
											<SubagentConclusion run={run} inTranscript />
											<FactsLine run={run} />
										</div>
									</div>
									{scroll.showScrollButton && (
										<ScrollToBottomButton
											onClick={scrollToBottom}
											hasUnseen={scroll.hasUnseen}
											unseen="new steps"
										/>
									)}
								</div>
							</section>
						</TranscriptViewContext>
					</SubagentTranscriptContext>
				</FullScreenHost>
			</CoverLayerContext>
		</div>
	);
}

/**
 * The path back and the row the level stands for, without its title — the
 * title is the last crumb (docs/subagent-transcript-ui.md#the-header).
 */
function LevelHeader({
	run,
	titles,
	onGoUp,
}: {
	run: ToolRun;
	titles: string[];
	onGoUp: (depth: number) => void;
}) {
	const resume = useSubagentResume(run.id);
	const rowRun = resumedRun(run, resume);
	// The row's own header, so the two cannot say different things about one
	// run: its glyph, chips and lines. No step window here (see Line 3).
	const { summary, glyph, firstLine, secondLine } = subagentHeader(rowRun);
	const line = secondLine.richSecondLine;
	const plainLine = secondLine.secondLine;

	return (
		<header className="shrink-0 border-b border-th-border bg-th-bg-primary text-xs">
			<div className="mx-auto w-full max-w-3xl px-3 pb-1.5 sm:px-4">
				<div className="-ml-3 flex items-center gap-2">
					<button
						type="button"
						onClick={() => onGoUp(titles.length - 1)}
						className={headerIconButtonClass}
						aria-label={`Back to ${titles.length > 1 ? titles[titles.length - 2] : "chat"}`}
					>
						<ArrowLeft className="size-5" aria-hidden="true" />
					</button>
					<Breadcrumb titles={titles} onGoUp={onGoUp} />
				</div>
				{/* The row's own columns: the glyph, then a text column holding
				    line 2 and line 3, so line 3 sits under the detail as it does
				    on the row. */}
				<div className="flex items-start gap-1.5">
					{glyph}
					<div className="min-w-0 flex-1">
						<div className="flex items-baseline gap-1.5">
							{firstLine.background && <Chip>background</Chip>}
							{firstLine.afterStop && <Chip tone="warning">after Stop</Chip>}
							<Detail
								detail={summary.detail}
								detailTail={summary.detailTail}
								mono={summary.mono}
								error={firstLine.error}
							/>
							{firstLine.meta}
						</div>
						{line ? (
							<span
								aria-hidden={line.live}
								className="flex min-w-0 items-baseline gap-1.5 text-th-text-muted"
							>
								{line.content}
							</span>
						) : (
							plainLine && (
								<span
									aria-hidden={plainLine.live}
									className={`block truncate text-th-text-muted ${plainLine.mono ? "font-mono" : ""}`}
								>
									{plainLine.text}
								</span>
							)
						)}
					</div>
				</div>
			</div>
		</header>
	);
}

/**
 * The path from the chat to the shown subagent. Too wide for the line, it
 * scrolls sideways and is kept at its end, so the shown subagent is always in
 * view; the way up is always ← (docs/subagent-transcript-ui.md#the-header).
 */
function Breadcrumb({
	titles,
	onGoUp,
}: {
	titles: string[];
	onGoUp: (depth: number) => void;
}) {
	const ref = useRef<HTMLElement>(null);
	const [cutAtStart, setCutAtStart] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const check = () => setCutAtStart(el.scrollLeft > 0);
		// A level's path never changes, so its end is pinned when it is drawn
		// and when the line's width does.
		const pin = () => {
			el.scrollLeft = el.scrollWidth;
			check();
		};
		pin();
		el.addEventListener("scroll", check, { passive: true });
		const observer = new ResizeObserver(pin);
		observer.observe(el);
		return () => {
			el.removeEventListener("scroll", check);
			observer.disconnect();
		};
	}, []);

	const current = titles[titles.length - 1];
	return (
		<nav
			ref={ref}
			aria-label="Subagent path"
			className={`min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] ${cutAtStart ? "[mask-image:linear-gradient(to_right,transparent,black_16px)]" : ""}`}
		>
			{/* As tall as the line, so a crumb's hit area is inside the
			    scroller rather than cut by it. */}
			<ol className="flex h-11 items-center gap-1 text-sm">
				<li className="flex shrink-0 items-center">
					<button
						type="button"
						onClick={() => onGoUp(0)}
						className="touch-target rounded text-th-text-secondary pointer-fine:hover:underline"
					>
						Chat
					</button>
				</li>
				{titles.slice(0, -1).map((title, index) => (
					<li
						// A path's crumbs are its levels, in place.
						// biome-ignore lint/suspicious/noArrayIndexKey: the index is the level
						key={index}
						className="flex max-w-[40%] shrink-0 items-center gap-1"
					>
						<CrumbSeparator />
						<button
							type="button"
							onClick={() => onGoUp(index + 1)}
							className="touch-target min-w-0 truncate rounded text-th-text-secondary pointer-fine:hover:underline"
						>
							{title}
						</button>
					</li>
				))}
				<li className="flex max-w-[60%] shrink-0 items-center gap-1">
					<CrumbSeparator />
					<span
						aria-current="page"
						className="flex min-w-0 items-center gap-1 font-medium text-th-text-primary"
					>
						<Bot aria-hidden className="size-3 shrink-0" />
						<span className="truncate">{current}</span>
					</span>
				</li>
			</ol>
		</nav>
	);
}

function CrumbSeparator() {
	return (
		<ChevronRight
			className="size-3 shrink-0 text-th-text-muted"
			aria-hidden="true"
		/>
	);
}
