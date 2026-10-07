import { useHasCoarsePointer } from "@pockode/shared";
import { Maximize2 } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	type Ref,
	type RefObject,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { FULL_SCREEN_OPENER_ATTR } from "../../lib/fullScreen";

/**
 * How much of the page a block may take before it is cut.
 *
 * - `main`: what the block is opened for — a command's output, a file, a
 *   change. A share of the transcript, so that on a landscape phone it is still
 *   half a screen and on a desktop it is not a sliver.
 * - `supporting`: what explains the main block — the command, the arguments, an
 *   error. Short, so that both fit on one screen together.
 */
export type ClampBudget = "main" | "supporting";

/**
 * What the content is counted in, for the button that opens it. Absent for
 * content with no unit a reader would count in — Markdown, a list of fields —
 * which is offered as "Show all".
 */
export interface ClampCount {
	noun: "line" | "file";
	/** How many of them the content draws in all. */
	total: number;
}

/**
 * The transcript's height, which `MessageList` keeps on its scroller. Outside a
 * transcript the window's stands in.
 */
export const TRANSCRIPT_HEIGHT_VAR = "--transcript-height";

/**
 * The scrolling view the block is read in, through which opening and closing
 * it keep the reader's place (docs/tool-call-ui.md#keeping-the-readers-place).
 * The transcript's own (`TranscriptView`) in a transcript; without one, the
 * page is left to do what it does.
 */
export interface ClampView {
	/** The view's top edge, in client coordinates. */
	top: () => number;
	/** The view's bottom edge, in client coordinates. */
	bottom: () => number;
	/**
	 * How far the view is scrolled. Compared between two looks, it is the one
	 * reading that only scrolling moves: a button appearing above a block, or
	 * the block itself changing height, moves the block on screen but not
	 * this.
	 */
	scrollTop: () => number;
	/** How much of the view's top is covered by bars pinned over `el`. */
	coveredAbove: (el: HTMLElement) => number;
	/**
	 * Puts `el`'s top `offset` pixels below the view's top edge and reads from
	 * there, through the view's own anchor.
	 */
	holdAt: (el: HTMLElement, offset: number) => void;
}

/**
 * What the block's header can do to it: a header pinned over an opened block
 * carries its own way to close it, for a reader far from the button.
 */
export interface ClampHandle {
	/** The same as pressing "Show less", place kept and all. */
	close: () => void;
}

/** Budgets and the tolerance are in lines of `text-xs`, which is 1rem tall. */
const SUPPORTING_LINES = 8;
const MAIN_MIN_LINES = 8;
const MAIN_SHARE = 0.45;
/**
 * The main budget's ceiling: a phone's transcript is short enough that a share
 * of it is already as much as a thumb wants to scroll past, while a desktop's
 * can hold more before a block stops being glanceable.
 */
const MAIN_CAP_LINES = { coarse: 20, fine: 30 };
/**
 * Content is cut only when more than this many lines would be hidden: a button
 * that reveals two lines costs more than the two lines do.
 */
const TOLERANCE_LINES = 6;

/** The box's budget, named once so the clamp and the tolerance share it. */
const BUDGET_VAR = "--clamp-budget";

function budgetHeight(budget: ClampBudget, coarse: boolean): string {
	if (budget === "supporting") return `${SUPPORTING_LINES}rem`;
	const cap = coarse ? MAIN_CAP_LINES.coarse : MAIN_CAP_LINES.fine;
	return `clamp(${MAIN_MIN_LINES}rem, calc(var(${TRANSCRIPT_HEIGHT_VAR}, 100svh) * ${MAIN_SHARE}), ${cap}rem)`;
}

function remPx(): number {
	return (
		Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
	);
}

/** What the clamp hides, as measured. */
interface Cut {
	/** The share of the content's height that is hidden. */
	share: number;
	/** The content's height in `text-xs` rows. */
	rows: number;
}

/**
 * What the button that opens the content says. A count is estimated from the
 * share of the height that is hidden: exact for content drawn in even rows — a
 * file, a log, a list of files — and close for the rest, which is still more
 * use than no number.
 */
function showLabel(
	from: "start" | "end",
	cut: Cut,
	count?: ClampCount,
): string {
	// Nothing counted — a change drawn without a patch — says nothing either.
	if (!count?.total) return "Show all";
	// Lines wrapping onto more than two rows each are prose in all but name —
	// one minified JSON answer is a single line — and their count says nothing
	// about how much is hidden: "Show 1 earlier line" over a screenful.
	if (count.noun === "line" && count.total * 2 < cut.rows) return "Show all";
	const n = Math.max(1, Math.round(count.total * cut.share));
	const which = from === "end" ? "earlier" : "more";
	return `Show ${n} ${which} ${count.noun}${n === 1 ? "" : "s"}`;
}

interface Props {
	children: ReactNode;
	/** See `ClampBudget`. */
	budget?: ClampBudget;
	/**
	 * Which end stays in view while clamped. `end` for output that is read from
	 * its tail — a build's verdict is its last line, not its first.
	 */
	from?: "start" | "end";
	/** See `ClampCount`. */
	count?: ClampCount;
	/**
	 * What the content is, completing the buttons' accessible names: "Show 340
	 * earlier lines of output".
	 */
	name?: string;
	/**
	 * Told before paint whenever the content starts or stops being cut, for a
	 * header that offers something only for content that is: Full screen.
	 */
	onCutChange?: (cut: boolean) => void;
	/**
	 * Offer Full screen beside the clamp's own button, for a block with no
	 * header to carry it — a plan, a subagent's report. `key` is what it is
	 * published under (`FULL_SCREEN_OPENER_ATTR`).
	 */
	fullScreen?: { key: string; open: () => void };
	/**
	 * Content too long to open in place (docs/tool-call-ui.md#huge-content):
	 * `children` is only a slice of it, always drawn cut, and the clamp's one
	 * button opens the viewer instead — `label` on screen, `name` to a screen
	 * reader. It replaces the headerless Full screen button too.
	 */
	huge?: { key: string; label: string; name: string; open: () => void };
	/** See `ClampView`. */
	view?: ClampView | null;
	/**
	 * The block's header, which precedes it and is pinned over it while it is
	 * open. Closing lands on it when the button's edge is out of sight, so the
	 * reader sees what they put away — the block itself without one — and a
	 * button under it counts as out of sight.
	 */
	landingRef?: RefObject<HTMLElement | null>;
	/** The box's id, for a control elsewhere that opens or closes it. */
	id?: string;
	/** See `ClampHandle`. */
	ref?: Ref<ClampHandle>;
	/**
	 * Told whenever the block is opened past its budget or closed back to it,
	 * in the same commit, so a header pinned while it is open is let go before
	 * closing lands on it.
	 */
	onOpenChange?: (open: boolean) => void;
	/**
	 * Output still arriving: while its bottom is in sight, it stays there and
	 * the content grows upward, until the reader scrolls up away from it.
	 */
	follow?: boolean;
}

/** A followed block as last seen. */
interface Followed {
	/** Its bottom edge, against the view's top. */
	bottom: number;
	height: number;
	/** The view's `scrollTop` then. */
	scrolled: number;
	following: boolean;
}

/** Whether a bottom edge `bottom` pixels below the view's top can be seen. */
function inSight(box: HTMLElement, view: ClampView, bottom: number): boolean {
	return (
		bottom > view.coveredAbove(box) &&
		bottom <= view.bottom() - view.top() + 0.5
	);
}

/** Takes a followed block's measure, following or not by its bottom. */
function lookAt(
	box: HTMLElement,
	view: ClampView,
	following: (bottom: number) => boolean,
): Followed {
	const rect = box.getBoundingClientRect();
	const bottom = rect.bottom - view.top();
	return {
		bottom,
		height: rect.height,
		scrolled: view.scrollTop(),
		following: following(bottom),
	};
}

const FADE_START =
	"[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]";
const FADE_END =
	"[mask-image:linear-gradient(to_top,black_calc(100%-3rem),transparent)]";

// A line-high box with the hit area laid over it rather than a box the hit
// area's height: two of these stand between a tool's command and its output,
// and at 44px each they alone pushed an open Bash row past a phone's
// transcript.
const TEXT_BUTTON =
	"touch-target rounded px-2 py-1 text-th-accent hover:bg-th-overlay-hover";

/**
 * Long content cut to its budget, faded where it is cut, and opened in place
 * on request — with the button on the side that is cut, where the hidden part
 * would be.
 *
 * Instead of a scroll box, because a scroll box inside a scrolling transcript
 * is a trap on a touch screen: a drag meant for the page is taken by whichever
 * box is under the thumb, and on a phone a tall one is under it most of the
 * time. Clipped content scrolls nothing, so every vertical drag stays the
 * page's. Sideways it does scroll — a file's lines keep their width — and a box
 * with nothing to scroll vertically hands a vertical drag on to the page.
 */
export function ClampedContent({
	children,
	budget = "supporting",
	from = "start",
	count,
	name,
	onCutChange,
	fullScreen,
	huge,
	view,
	landingRef,
	id,
	ref,
	onOpenChange,
	follow = false,
}: Props) {
	const ownId = useId();
	const boxId = id ?? ownId;
	const coarse = useHasCoarsePointer();
	const rootRef = useRef<HTMLDivElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const toggleRef = useRef<HTMLButtonElement>(null);
	/** Puts the reader's place back once the next layout has moved it. */
	const landRef = useRef<(() => void) | null>(null);
	const followedRef = useRef<Followed | null>(null);
	/**
	 * Closed from a control that closing takes away — the pinned header's —
	 * whose focus would otherwise fall to the page.
	 */
	const refocusRef = useRef(false);
	// Null when the content fits.
	const [cut, setCut] = useState<Cut | null>(null);
	const [showAll, setShowAll] = useState(false);

	// Huge content is never measured: it is cut by definition, and what is
	// drawn of it is a slice that says nothing about the whole.
	const isHuge = huge !== undefined;
	const clamped = isHuge || (cut !== null && !showAll);
	// Kept once opened — the effect does not measure an open box — so "Show
	// less" and Full screen stay on offer.
	const overflowing = isHuge || cut !== null;

	const onCutChangeRef = useRef(onCutChange);
	onCutChangeRef.current = onCutChange;
	// From an effect on the decided cut, not from inside the measuring updater,
	// and before paint, so the header's button never flashes in late.
	useLayoutEffect(() => {
		onCutChangeRef.current?.(overflowing);
	}, [overflowing]);
	useLayoutEffect(() => () => onCutChangeRef.current?.(false), []);

	// Measured before paint, so content that fits never flashes its button.
	// Both elements are watched: the content as it grows, the box as its budget
	// moves with the transcript's height.
	useLayoutEffect(() => {
		const box = boxRef.current;
		const content = box?.firstElementChild;
		if (!box || !(content instanceof HTMLElement) || showAll || isHuge) return;

		// The content's height and not the box's `scrollHeight`: an end-anchored
		// column overflows upwards, and overflow on that side is not scrollable
		// overflow, so `scrollHeight` never exceeds the box there.
		const measure = () => {
			const total = content.offsetHeight;
			const rem = remPx();
			const tolerance = TOLERANCE_LINES * rem;
			// Cut, the box stops at the budget. Uncut, it stops at budget +
			// tolerance, so content past that is worth cutting, and what the
			// budget would hide of it is the tolerance more than the box does.
			const hidden = box.hasAttribute("data-clamped")
				? total - box.clientHeight
				: total > box.clientHeight + 1
					? total - box.clientHeight + tolerance
					: 0;
			const share = hidden / total;
			const rows = total / rem;
			setCut((prev) =>
				hidden < tolerance
					? null
					: prev?.share === share && prev.rows === rows
						? prev
						: { share, rows },
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(content);
		observer.observe(box);
		return () => observer.disconnect();
	}, [showAll, isHuge]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: showAll is the commit a landing waits for
	useLayoutEffect(() => {
		const land = landRef.current;
		landRef.current = null;
		const refocus = refocusRef.current;
		refocusRef.current = false;
		land?.();
		if (refocus && document.activeElement === document.body) {
			toggleRef.current?.focus({ preventScroll: true });
		}
		if (!land) return;
		// The landing's own scroll is not the reader's, and a reader who just
		// opened or closed a followed block is reading it: it is followed from
		// here whenever its bottom is in sight.
		const box = boxRef.current;
		if (followedRef.current && box && view) {
			followedRef.current = lookAt(box, view, (bottom) =>
				inSight(box, view, bottom),
			);
		}
	}, [showAll, view]);

	// Live output grows at its bottom, which is where it is read: held there
	// while it is in sight, so what arrives pushes what came before up rather
	// than itself out of view. Only when it would otherwise leave the view —
	// within it the reader's eyes can follow the growth, and a transcript
	// following its tail already holds the end.
	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!follow || !view || !box) return;
		followedRef.current = lookAt(box, view, () => true);
		const observer = new ResizeObserver(() => {
			const last = followedRef.current;
			if (!last || box.getBoundingClientRect().height === last.height) return;
			// Where the bottom the reader saw is now: moved by scrolling and by
			// nothing else. Scrolled up is the reader leaving the tail; scrolled
			// down, coming back to it — or the transcript, following its own
			// end, taking the block along.
			const scrolled = view.scrollTop() - last.scrolled;
			const seen = last.bottom - scrolled;
			const sighted = inSight(box, view, seen);
			const following =
				scrolled < -0.5 ? false : scrolled > 0.5 ? sighted : last.following;
			const visibleBottom = view.bottom() - view.top();
			const rect = box.getBoundingClientRect();
			if (
				following &&
				sighted &&
				rect.bottom - view.top() > visibleBottom + 0.5
			) {
				view.holdAt(box, seen - rect.height);
			}
			followedRef.current = lookAt(box, view, () => following);
		});
		observer.observe(box);
		return () => observer.disconnect();
	}, [follow, view]);

	/**
	 * Opens or closes the block without moving what the reader was looking at
	 * (docs/tool-call-ui.md#keeping-the-readers-place): opening holds the edge
	 * the content is kept at — its top, or for content read from its tail its
	 * bottom, so it grows upward — and closing holds the button, which is on
	 * the edge that is cut. A button out of sight leaves nothing to hold, and
	 * the block's header is landed just under whatever is pinned over it.
	 */
	const setOpen = (open: boolean) => {
		const box = boxRef.current;
		const button = toggleRef.current;
		if (view && box) {
			const top = view.top();
			const rect = box.getBoundingClientRect();
			if (open && from === "end") {
				const bottom = rect.bottom - top;
				landRef.current = () =>
					view.holdAt(box, bottom - box.getBoundingClientRect().height);
			} else if (open) {
				const offset = rect.top - top;
				landRef.current = () => view.holdAt(box, offset);
			} else if (button) {
				const at = button.getBoundingClientRect();
				const covered = view.coveredAbove(button);
				const offset = at.top - top;
				const header = landingRef?.current;
				const landing = header ?? rootRef.current;
				// The header is pinned over the content while it is open, so a
				// button under it is as hidden as one under the row's bar.
				const hiddenTo = Math.max(
					top + covered,
					header ? header.getBoundingClientRect().bottom : top,
				);
				// Any of it in sight is where it was pressed: a tap lands on the
				// overlay round it, which reaches past a box half under the bar.
				if (at.bottom > hiddenTo && at.top < view.bottom()) {
					landRef.current = () => view.holdAt(button, offset);
				} else if (landing) {
					// Out of sight, the header is what is landed on: where it is,
					// when the reader can see it — pinned, that is just under the
					// title — and otherwise brought down to just under the title.
					const head = landing.getBoundingClientRect();
					const seen =
						head.top >= top + covered - 0.5 && head.top < view.bottom();
					const landAt = seen ? head.top - top : covered;
					landRef.current = () => view.holdAt(landing, landAt);
				}
			}
		}
		setShowAll(open);
		onOpenChange?.(open);
	};

	useImperativeHandle(ref, () => ({
		close: () => {
			refocusRef.current = true;
			setOpen(false);
		},
	}));

	const limit = budgetHeight(budget, coarse);
	const label = showAll ? "Show less" : cut && showLabel(from, cut, count);
	const toggle = huge ? (
		<button
			ref={toggleRef}
			type="button"
			onClick={huge.open}
			{...{ [FULL_SCREEN_OPENER_ATTR]: huge.key }}
			aria-haspopup="dialog"
			aria-label={huge.name}
			className={`flex items-center gap-1 text-left ${TEXT_BUTTON}`}
		>
			<Maximize2 className="size-3 shrink-0" aria-hidden="true" />
			{huge.label}
		</button>
	) : (
		overflowing && (
			<button
				ref={toggleRef}
				type="button"
				onClick={() => setOpen(!showAll)}
				aria-expanded={showAll}
				aria-controls={boxId}
				aria-label={name ? `${label} of ${name}` : undefined}
				className={TEXT_BUTTON}
			>
				{label}
			</button>
		)
	);
	// The button sits on the side the content is cut on: below for content cut
	// at its end, above — between the header and the content — for content
	// read from its tail.
	const toggleAbove = from === "end";

	return (
		<div ref={rootRef}>
			{toggleAbove && toggle && (
				// Under a header, whose buttons' hit areas reach 10px below its
				// line under a thumb, as this one's reaches 10px above: a label as
				// long as this one would run under them. The header's `pb-1` and
				// this 16px make the 20px the two reach.
				<div className={huge ? "pointer-coarse:mt-4" : undefined}>{toggle}</div>
			)}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the focus listener only watches focus arriving at a control inside; the box itself takes none */}
			<div
				ref={boxRef}
				id={boxId}
				data-clamped={clamped || undefined}
				// A keyboard reaching a control in the cut-off part would make the
				// browser scroll this clipped box to it — scrolling a box the user
				// cannot scroll back. Opening it instead keeps the box at rest.
				onFocus={(e) => {
					if (clamped && !huge && e.target.matches(":focus-visible"))
						setOpen(true);
				}}
				// Huge content cannot be opened instead, so the browser's scroll
				// to a control past the fade is undone: the box rests at its top.
				onScroll={(e) => {
					if (huge && e.currentTarget.scrollTop !== 0)
						e.currentTarget.scrollTop = 0;
				}}
				// Uncut, the box is allowed the tolerance on top of the budget:
				// content that fits there is shown whole, and content that does not
				// is the content worth cutting.
				style={
					showAll && !huge
						? undefined
						: ({
								[BUDGET_VAR]: limit,
								maxHeight: clamped
									? `var(${BUDGET_VAR})`
									: `calc(var(${BUDGET_VAR}) + ${TOLERANCE_LINES}rem)`,
							} as CSSProperties)
				}
				// `overflow-y-hidden` is not only the clip: `overflow-x-auto` alone
				// would make the other axis `auto` as well, and the box a vertical
				// scroller again.
				className={`overflow-x-auto overflow-y-hidden ${
					from === "end" ? "flex flex-col justify-end" : ""
				} ${clamped ? (from === "end" ? FADE_END : FADE_START) : ""}`}
			>
				{/* One element, so there is one height to watch. `shrink-0` keeps
				    the end-anchored column from squeezing it to the box instead of
				    letting it overflow the top. */}
				<div className="min-w-0 shrink-0">{children}</div>
			</div>
			{((!toggleAbove && toggle) || (overflowing && fullScreen && !huge)) && (
				<div className="flex items-center gap-2">
					{!toggleAbove && toggle}
					{overflowing && fullScreen && !huge && (
						<button
							type="button"
							onClick={fullScreen.open}
							{...{ [FULL_SCREEN_OPENER_ATTR]: fullScreen.key }}
							aria-haspopup="dialog"
							className={`flex items-center gap-1 ${TEXT_BUTTON}`}
						>
							<Maximize2 className="size-3" aria-hidden="true" />
							Full screen
						</button>
					)}
				</div>
			)}
		</div>
	);
}
