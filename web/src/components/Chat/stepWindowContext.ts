import { MEDIA_QUERIES, useMediaQuery } from "@pockode/shared";
import {
	createContext,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import { stepWindowLines } from "../../lib/subagentRun";
import type { ToolRun } from "../../types/message";

/**
 * How many step-window lines the subagent rows of a list get
 * (`stepWindowLines`). The list provides it: the size depends on how many
 * siblings a row has, which a row cannot see.
 */
export const StepWindowContext = createContext<number | null>(null);

/** Narrower than `sm`: the phone tier, where windows are smaller. */
export function useIsCompact(): boolean {
	return !useMediaQuery(MEDIA_QUERIES.atLeastRegular);
}

/** This row's window lines. A row outside a list is a list of one. */
export function useStepWindowLines(rowRun: ToolRun): number {
	const lines = useContext(StepWindowContext);
	const compact = useIsCompact();
	return lines ?? stepWindowLines([rowRun], compact);
}

/**
 * The settled windows that have folded, by run id, held above the rows so a
 * remount — a group collapsed and reopened, a bubble drawn again — cannot
 * regrow one in front of the reader
 * (docs/tool-call-ui.md#settling-and-folding). `MessageList` owns it; null
 * outside a transcript, where nothing is watched and a settled window folds
 * as it settles.
 */
export interface StepWindowFold {
	folded: ReadonlySet<string>;
	/**
	 * The runs seen live while the open turn was: a subagent resumed this turn
	 * from a row in an earlier reply belongs to it as much as a new one does.
	 * Empty while no turn is open.
	 */
	liveThisTurn: ReadonlySet<string>;
	fold: (id: string) => void;
	/**
	 * Says a run is live: its fold is forgotten, so a resumed run can fold
	 * anew, and while a turn is open it is counted in `liveThisTurn`.
	 */
	markLive: (id: string) => void;
	/** The transcript's scroller, which "unseen" is measured against. */
	scroller: () => HTMLElement | null;
}

export const StepWindowFoldContext = createContext<StepWindowFold | null>(null);

/**
 * Whether this bubble is one of the open turn's replies. Per bubble rather
 * than read off the turn tail, which changes on every thinking delta and
 * would re-render every row with it.
 */
export const InOpenTurnContext = createContext(false);

function isWhollyOutside(el: Element, root: Element): boolean {
	const row = el.getBoundingClientRect();
	const view = root.getBoundingClientRect();
	return row.bottom <= view.top || row.top >= view.bottom;
}

/**
 * Whether a settled subagent row keeps its frozen window, how many lines it
 * draws, and the ref of the element whose visibility decides it. It keeps it
 * until the first of: its turn is no longer open, the row is wholly out of
 * view, or its Process is open inline — and once folded it stays folded. A
 * fold can only happen where the reader does not see it, or at the turn's
 * end.
 *
 * `lines` is the list's size now; a frozen window keeps the size it settled
 * at, so a sibling spawned after it cannot shrink it in front of the reader.
 */
export function useStepWindowFold(
	id: string,
	settled: boolean,
	processOpen: boolean,
	lines: number,
) {
	const ctx = useContext(StepWindowFoldContext);
	const inOpenTurn = useContext(InOpenTurnContext);
	const [settledLines, setSettledLines] = useState(lines);
	if (!settled && settledLines !== lines) setSettledLines(lines);
	const latched = ctx?.folded.has(id) ?? false;
	const inTurn = inOpenTurn || (ctx?.liveThisTurn.has(id) ?? false);
	const kept =
		settled &&
		settledLines > 0 &&
		inTurn &&
		ctx !== null &&
		!latched &&
		!processOpen;
	const [node, setNode] = useState<HTMLElement | null>(null);
	const fold = ctx?.fold;
	const markLive = ctx?.markLive;
	const scroller = ctx?.scroller;

	// Again whenever a turn opens (`markLive` changes with it), for a run that
	// was already live before.
	useEffect(() => {
		if (!settled) markLive?.(id);
	}, [settled, markLive, id]);

	// Opening the Process inline shows the same steps whole; closing it again
	// does not bring back a window the reader has already seen go.
	useLayoutEffect(() => {
		if (settled && inTurn && processOpen && !latched) fold?.(id);
	}, [settled, inTurn, processOpen, latched, fold, id]);

	useLayoutEffect(() => {
		if (!kept || !node || !fold || !scroller) return;
		const root = scroller();
		if (!root) return;
		// Measured here, before paint, rather than left to the observer, whose
		// first report comes a frame later: a row laid out out of view folds
		// before it is painted frozen. (On a mount this runs before the
		// transcript has pinned its scroll for the commit; a row that measure
		// misplaces is caught by the observer, still unseen.)
		if (isWhollyOutside(node, root)) {
			fold(id);
			return;
		}
		// No margin: a row under the pinned bars still counts as seen, so it
		// folds a little later — the safe direction.
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => !entry.isIntersecting)) fold(id);
			},
			{ root, threshold: 0 },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [kept, node, fold, scroller, id]);

	return { kept, lines: settled ? settledLines : lines, ref: setNode };
}

const NONE: ReadonlySet<string> = new Set();

function withId(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
	return prev.has(id) ? prev : new Set(prev).add(id);
}

function withoutId(prev: ReadonlySet<string>, id: string): ReadonlySet<string> {
	if (!prev.has(id)) return prev;
	const next = new Set(prev);
	next.delete(id);
	return next;
}

/**
 * The fold latch's value, for `MessageList`. Cleared once no turn is open:
 * every settled window outside an open turn is drawn folded anyway.
 */
export function useStepWindowFoldValue(
	turnOpen: boolean,
	scrollRef: RefObject<HTMLElement | null>,
): StepWindowFold {
	const [folded, setFolded] = useState(NONE);
	const [live, setLive] = useState(NONE);
	const fold = useCallback((id: string) => setFolded((p) => withId(p, id)), []);
	const markLive = useCallback(
		(id: string) => {
			setFolded((p) => withoutId(p, id));
			if (turnOpen) setLive((p) => withId(p, id));
		},
		[turnOpen],
	);
	const scroller = useCallback(() => scrollRef.current, [scrollRef]);
	useEffect(() => {
		if (turnOpen) return;
		setFolded(NONE);
		setLive(NONE);
	}, [turnOpen]);
	// Read through `turnOpen` too, so the frame the turn closes in does not
	// keep a window on last turn's set before the effect has cleared it.
	const liveThisTurn = turnOpen ? live : NONE;
	return useMemo(
		() => ({ folded, liveThisTurn, fold, markLive, scroller }),
		[folded, liveThisTurn, fold, markLive, scroller],
	);
}
