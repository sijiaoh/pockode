import { useHasCoarsePointer, useIsExpanded } from "@pockode/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { useElementWidth } from "../../hooks/useElementWidth";
import type { HistoryRow } from "../../hooks/useHistoryGraph";
import { foldRow, type GraphRow } from "../../lib/commitGraph";
import {
	graphWidth,
	LANE_WIDTH,
	laneCap,
	lanesUsed,
	lineColor,
	MENU_WIDTH,
	ROW_GAP,
	ROW_HEIGHT,
} from "../../lib/commitHistory";
import { Spinner } from "../ui";
import CommitRow from "./CommitRow";
import { scrollSpanIntoView } from "./revealRow";

/** What the last row of the list says (docs/git-history-ui.md#paging-and-states). */
export type HistoryFooter =
	| { kind: "loading" }
	| { kind: "failed"; text: string; reason: string }
	| { kind: "end"; text: string };

interface Props {
	rows: HistoryRow[];
	footer: HistoryFooter;
	/** Asks for the next page; the caller ignores it when one is on its way. */
	onLoadMore: () => void;
	onRetry: () => void;
	activeHash: string | null;
	/**
	 * Set while the lit row is wanted on screen; called once it is — which
	 * waits for the page that lists it.
	 */
	reveal?: () => void;
	onSelectCommit: (hash: string) => void;
	onOpenMenu: (row: HistoryRow) => void;
	/**
	 * A scroll area of the page's own that the list sits in, below other
	 * content, rather than one of the list's: `margin` is how far down that
	 * area the list starts, kept current by the caller as what is above it
	 * changes height. Mounted with the list and kept for its life.
	 */
	scroller?: { element: HTMLElement; margin: number };
}

const OVERSCAN = 10;

/**
 * A list of commits in a virtual list: only the rows near the screen are
 * mounted, every row 52px. The next page is asked for when the reader is
 * within a screen of the end.
 *
 * It scrolls on its own, as History's list does, or inside a `scroller` with
 * whatever is above it, as a branch's commits do under its facts.
 */
function HistoryList({
	rows,
	footer,
	onLoadMore,
	onRetry,
	activeHash,
	reveal,
	onSelectCommit,
	onOpenMenu,
	scroller,
}: Props) {
	const rootRef = useRef<HTMLDivElement>(null);
	// The outer element never changes for the list's life, so a ref to it
	// serves both cases.
	const outerRef = useRef<HTMLElement | null>(scroller?.element ?? null);
	const scrollerRef = scroller ? outerRef : rootRef;
	const margin = scroller?.margin ?? 0;
	const isExpanded = useIsExpanded();
	const menuWidth = useHasCoarsePointer() ? MENU_WIDTH.coarse : MENU_WIDTH.fine;
	const listWidth = useElementWidth(rootRef);
	const cap = laneCap(listWidth, menuWidth, isExpanded);

	// Only grows: a page arriving may move the text column right once, but a
	// column that also shrank would move under the reader's finger. Another
	// range or filter is another instance (HistorySection keys it), so it
	// starts narrow again.
	const widest = useRef(0);
	// Per page of rows, not per render: scrolling re-renders the list.
	const used = useMemo(
		() =>
			rows.reduce(
				(most, row) =>
					row.graph ? Math.max(most, lanesUsed(row.graph)) : most,
				-1,
			),
		[rows],
	);
	widest.current = Math.max(widest.current, used);
	const graphColumn = used >= 0 ? graphWidth(widest.current, cap) : LANE_WIDTH;
	const textWidth = listWidth - ROW_GAP * 2 - graphColumn - menuWidth;

	const count = rows.length + 1;
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollerRef.current,
		scrollMargin: margin,
		estimateSize: () => ROW_HEIGHT,
		overscan: OVERSCAN,
		getItemKey: (index) => rows[index]?.commit.hash ?? "footer",
	});
	const items = virtualizer.getVirtualItems();

	const lastIndex = items.at(-1)?.index ?? 0;
	const screenRows = Math.ceil(
		(scrollerRef.current?.clientHeight ?? 0) / ROW_HEIGHT,
	);
	const nearEnd = lastIndex >= rows.length - screenRows - 1;
	// Keyed by the row count, so a page that lands with the reader still near
	// the end asks for the next one.
	const loadMoreAt = nearEnd ? rows.length : -1;
	useEffect(() => {
		if (loadMoreAt !== -1 && footer.kind === "loading") onLoadMore();
	}, [loadMoreAt, footer.kind, onLoadMore]);

	useKeepTopRow(scrollerRef, rows, margin);

	// From the row's offset rather than its element: it may be one the virtual
	// list has not mounted.
	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (!reveal || !el) return;
		const index = rows.findIndex((r) => r.commit.hash === activeHash);
		if (index === -1) return;
		const top = margin + index * ROW_HEIGHT;
		scrollSpanIntoView(el, top, top + ROW_HEIGHT);
		reveal();
	});

	const lastGraph = rows.at(-1)?.graph;
	return (
		<div
			ref={rootRef}
			// The width every row's layout follows (`@git-commit-row`): the list's
			// own, which does not move as pages arrive the way its text column
			// does.
			className={
				scroller ? "@container" : "@container min-h-0 flex-1 overflow-y-auto"
			}
		>
			<ul
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{items.map((item) => {
					const row = rows[item.index];
					return (
						<li
							key={item.key}
							className="absolute inset-x-0 top-0"
							style={{
								height: ROW_HEIGHT,
								transform: `translateY(${item.start - margin}px)`,
							}}
						>
							{row ? (
								<CommitRow
									row={row}
									cap={cap}
									graphWidth={graphColumn}
									textWidth={textWidth}
									isActive={row.commit.hash === activeHash}
									onSelect={onSelectCommit}
									onOpenMenu={onOpenMenu}
								/>
							) : (
								<FooterRow
									footer={footer}
									onRetry={onRetry}
									openLines={
										footer.kind === "loading" && lastGraph
											? openLinesBelow(lastGraph, cap)
											: []
									}
									graphColumn={graphColumn}
								/>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/**
 * The lanes still running at the bottom of the last row, once each: a merge's
 * curve into a lane and that lane's own line end in the same column.
 */
function openLinesBelow(
	row: GraphRow,
	cap: number,
): { column: number; line: number }[] {
	const byColumn = new Map<number, number>();
	for (const edge of foldRow(row, cap).below) {
		if (edge.to < cap && !byColumn.has(edge.to)) {
			byColumn.set(edge.to, edge.line);
		}
	}
	return [...byColumn].map(([column, line]) => ({ column, line }));
}

function FooterRow({
	footer,
	onRetry,
	openLines,
	graphColumn,
}: {
	footer: HistoryFooter;
	onRetry: () => void;
	/** Lines still running at the bottom of the last row, which fade out here. */
	openLines: { column: number; line: number }[];
	graphColumn: number;
}) {
	const fadeId = useId();
	if (footer.kind === "end") {
		return (
			<div className="flex h-full items-center justify-center px-4 text-center text-xs text-th-text-muted">
				{footer.text}
			</div>
		);
	}
	if (footer.kind === "failed") {
		return (
			<div className="flex h-full items-center gap-2 px-4 text-xs">
				<span className="min-w-0 flex-1 truncate text-th-error">
					{footer.text}{" "}
					<span className="text-th-text-muted">{footer.reason}</span>
				</span>
				<button
					type="button"
					onClick={onRetry}
					className="min-h-[36px] shrink-0 rounded-md px-3 text-sm text-th-accent hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
				>
					Retry
				</button>
			</div>
		);
	}
	return (
		<div className="flex h-full items-center gap-2 pl-2 text-xs text-th-text-muted">
			<svg
				width={graphColumn}
				height={ROW_HEIGHT}
				className="shrink-0"
				aria-hidden="true"
				focusable="false"
			>
				<defs>
					<linearGradient id={`${fadeId}-g`} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor="white" />
						<stop offset="1" stopColor="white" stopOpacity="0" />
					</linearGradient>
					{/* In user space: one straight line has a zero-width bounding
					    box, and a mask sized by it hides the line entirely. */}
					<mask
						id={`${fadeId}-m`}
						maskUnits="userSpaceOnUse"
						x={0}
						y={0}
						width={graphColumn}
						height={ROW_HEIGHT}
					>
						<rect
							width={graphColumn}
							height={ROW_HEIGHT}
							fill={`url(#${fadeId}-g)`}
						/>
					</mask>
				</defs>
				<g mask={`url(#${fadeId}-m)`}>
					{openLines.map(({ column, line }) => (
						<path
							key={column}
							d={`M${column * LANE_WIDTH + 7} 0V${ROW_HEIGHT}`}
							stroke={lineColor(line)}
							strokeWidth={2}
						/>
					))}
				</g>
			</svg>
			<Spinner variant="current" className="size-3" />
			Loading older commits…
		</div>
	);
}

/**
 * Keeps the reader on the commit at the top of the screen when the list is
 * re-read and that commit moved — rewritten history, new commits above it.
 * An appended page moves nothing, a commit no longer listed leaves the view
 * where it was, and a reader at the very top stays there to see what is new.
 */
function useKeepTopRow(
	scrollerRef: React.RefObject<HTMLElement | null>,
	rows: HistoryRow[],
	/** Where in the scroll area the first row starts. */
	margin: number,
) {
	const top = useRef<{ index: number; hash: string } | null>(null);
	const rowsRef = useRef(rows);
	const marginRef = useRef(margin);
	useLayoutEffect(() => {
		marginRef.current = margin;
	}, [margin]);
	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const onScroll = () => {
			const scrolled = el.scrollTop - marginRef.current;
			// At the very top the reader is reading what is newest, and a commit
			// arriving above belongs on screen rather than pushed out of it —
			// as is a reader still above the list, reading what heads it.
			if (scrolled <= 0) {
				top.current = null;
				return;
			}
			const index = Math.floor(scrolled / ROW_HEIGHT);
			const hash = rowsRef.current[index]?.commit.hash;
			top.current = hash ? { index, hash } : null;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [scrollerRef]);

	useLayoutEffect(() => {
		rowsRef.current = rows;
		const el = scrollerRef.current;
		const anchor = top.current;
		if (!el || !anchor || rows[anchor.index]?.commit.hash === anchor.hash) {
			return;
		}
		const moved = rows.findIndex((r) => r.commit.hash === anchor.hash);
		if (moved === -1) return;
		el.scrollTop += (moved - anchor.index) * ROW_HEIGHT;
		top.current = { index: moved, hash: anchor.hash };
	}, [rows, scrollerRef]);
}

export default HistoryList;
