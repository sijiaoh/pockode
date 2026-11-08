import { useIsPageCovered, useOutsideClick } from "@pockode/shared";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PrefillComposer } from "../../hooks/usePrefillComposer";
import type { DiffHunk } from "../../lib/diffHunks";
import {
	applyPress,
	buildDiffRows,
	capitalize,
	type DiffSource,
	describeRange,
	hunkLineRange,
	type LinePress,
	type LineRange,
	rangeSignature,
	relocateRange,
	resolveRange,
	rowKey,
	selectionCopyText,
	selectionPrefillText,
} from "../../lib/diffRows";
import type { GitDiffData } from "../../types/git";
import { isGutter, shownLineKeys } from "../ui/lineGutter";
import { HUNK_BAR_ATTRIBUTE, HUNK_BAR_FRAMES } from "./HunkBar";
import LineSelectionBar from "./LineSelectionBar";

/**
 * A selection as held: the range, what it was made over — a side, a
 * whitespace setting, a layout, any change of which clears it — and its rows'
 * content when it was made, which a refreshed diff has to match for it to stay.
 */
interface HeldSelection extends LineRange {
	scope: string;
	signature: string;
	/** Whether the anchor is the top end, kept when the rows are found again. */
	anchorFirst: boolean;
}

/**
 * What a click on the page leaves the line selection alone for: a control
 * does what it does, and a press there is never also a dismissal. The gap row
 * is one, its whole width expanding it.
 */
const INTERACTIVE =
	'button, a[href], input, textarea, select, label, summary, [role="button"], [role="checkbox"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"]), [contenteditable="true"], .diff-line-hunk';

interface Options {
	path: string;
	diff: GitDiffData | undefined;
	hunks: DiffHunk[];
	/** What the diff compares, for the draft to name the version. */
	source: DiffSource;
	/** Side by side, where a hunk's Select picks one side (`hunkLineRange`). */
	split?: boolean;
	/**
	 * What the selection was made over beyond the diff itself — a side, a
	 * whitespace setting, a layout. A change of it clears the selection.
	 */
	scope: string;
	/** Wraps the diff: the draft reads from it which lines are on screen. */
	bodyRef: RefObject<HTMLDivElement | null>;
	prefill: PrefillComposer;
}

/**
 * Lines selected by the gutter or a hunk bar's Select (`selectHunk`), and the
 * bar that copies them or hands them to the agent
 * (docs/git-changes-ui.md#handing-lines-to-the-agent). One implementation for
 * every diff that offers it: the review, and a commit's file diff.
 */
export function useLineSelection({
	path,
	diff,
	hunks,
	source,
	split = false,
	scope,
	bodyRef,
	prefill,
}: Options) {
	const rows = useMemo(
		() =>
			diff && !diff.omitted
				? buildDiffRows(hunks, {
						old: diff.old_content,
						new: diff.new_content,
					})
				: [],
		[diff, hunks],
	);
	const [held, setHeld] = useState<HeldSelection | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const selection = useMemo(() => {
		if (!held || held.scope !== scope) return null;
		const found = relocateRange(rows, held, held.signature, held.anchorFirst);
		if (!found) return null;
		return {
			...found,
			description: describeRange(found.selected, held.view),
		};
	}, [held, rows, scope]);
	// A refreshed diff that no longer has every selected row as it was — the
	// agent edited them, or their hunk was staged in the review — takes the
	// selection with it; a new side, setting or layout does too, without
	// needing saying. No
	// diff at all is a connection being re-established, which says nothing
	// about the file: the selection waits for the diff to come back.
	useEffect(() => {
		// Found again under other keys: held under those, so the next refresh
		// takes the quick path instead of searching the file once more.
		if (
			held &&
			selection &&
			(selection.range.anchor !== held.anchor ||
				selection.range.focus !== held.focus)
		) {
			setHeld({
				...held,
				anchor: selection.range.anchor,
				focus: selection.range.focus,
			});
			return;
		}
		if (!held || selection) return;
		if (held.scope !== scope) {
			setHeld(null);
			return;
		}
		if (!diff) return;
		setHeld(null);
		setAnnouncement("Selection cleared — the file changed");
	}, [held, selection, scope, diff]);

	const barRef = useRef<HTMLDivElement>(null);
	const copyRef = useRef<HTMLButtonElement>(null);
	const focusCopy = useRef(false);
	const select = (range: LineRange | null, by: "pointer" | "button") => {
		const selected = range && resolveRange(rows, range);
		if (!range || !selected) {
			setHeld(null);
			return;
		}
		setHeld({
			view: range.view,
			anchor: range.anchor,
			focus: range.focus,
			scope,
			signature: rangeSignature(selected, range.view),
			anchorFirst: rowKey(selected[0], range.view) === range.anchor,
		});
		// A press in the gutter moves no focus, so it is said; the hunk bar's
		// Select takes focus to the bar, which says it there.
		if (by === "pointer") {
			const { label } = describeRange(selected, range.view);
			setAnnouncement(`${capitalize(label)} selected`);
		} else {
			focusCopy.current = true;
		}
	};
	useEffect(() => {
		if (!selection || !focusCopy.current) return;
		focusCopy.current = false;
		copyRef.current?.focus();
	}, [selection]);

	// When the bar goes while it holds focus — ✕, Escape, a refresh — focus
	// goes back to the Select button of the hunk the selection was in, rather
	// than to the page's body. Tracked by focus events because by the time the
	// bar is gone, so is the element that had focus.
	const barHasFocus = useRef(false);
	const selectionHunk = useRef(0);
	useLayoutEffect(() => {
		if (!selection) return;
		// The hunk the selection is in, or the last one before it — a range of
		// unchanged lines only is in none.
		const start = rows.indexOf(selection.selected[0]);
		const inHunk =
			selection.selected.find((row) => row.hunk !== undefined) ??
			rows
				.slice(0, Math.max(start, 0))
				.findLast((row) => row.hunk !== undefined);
		selectionHunk.current = inHunk?.hunk ?? 0;
	});
	useEffect(() => {
		if (selection || !barHasFocus.current) return;
		barHasFocus.current = false;
		let frame = 0;
		let request = requestAnimationFrame(function restore() {
			// Only while focus is nowhere: a late frame must not take it from
			// wherever the reader has gone since.
			const { activeElement } = document;
			if (activeElement && activeElement !== document.body) return;
			// By index, not by place: unwrapped split view draws each bar in the
			// table of its side, so the page's order is not the hunks'. The hunk
			// may have left with the change that cleared the selection.
			const indices = [
				...(bodyRef.current?.querySelectorAll(`[${HUNK_BAR_ATTRIBUTE}]`) ?? []),
			].map((bar) => Number(bar.getAttribute(HUNK_BAR_ATTRIBUTE)));
			const wanted = selectionHunk.current;
			const index =
				indices.filter((i) => i <= wanted).sort((a, b) => b - a)[0] ??
				Math.min(...indices);
			const button = bodyRef.current?.querySelector<HTMLElement>(
				`[${HUNK_BAR_ATTRIBUTE}="${index}"] button[aria-label^="Select "]`,
			);
			// Kept where it is: the reader is looking at the selection, which
			// may be far from its hunk's bar.
			if (button) button.focus({ preventScroll: true });
			else if (++frame < HUNK_BAR_FRAMES) {
				request = requestAnimationFrame(restore);
			}
		});
		return () => cancelAnimationFrame(request);
	}, [selection, bodyRef]);

	// Through refs so the diff is not redrawn for them: a new hunk bar on
	// every render would redraw the whole diff's extend rows.
	const pressLine = useRef((_: LinePress) => {});
	const pressSelect = useRef((_: number) => {});
	useLayoutEffect(() => {
		pressLine.current = (press) =>
			select(applyPress(selection?.range ?? null, press), "pointer");
		pressSelect.current = (index) =>
			select(hunkLineRange(rows, index, split), "button");
	});
	const onLinePress = useCallback(
		(press: LinePress) => pressLine.current(press),
		[],
	);
	const selectHunk = useCallback(
		(index: number) => pressSelect.current(index),
		[],
	);
	const selectedLines = useMemo(
		() =>
			selection && {
				view: selection.range.view,
				keys: new Set(
					selection.selected.map(
						(row) => rowKey(row, selection.range.view) ?? "",
					),
				),
			},
		[selection],
	);

	// The bar has no backdrop, so it follows the conventions for an overlay
	// without one (docs/answering-ui.md): it claims the Escape and the click it
	// clears on, and stands down for whatever is drawn over the page.
	const isPageCovered = useIsPageCovered();
	const covered = useRef(isPageCovered);
	covered.current = isPageCovered;
	const hasSelection = selection !== null;
	useEffect(() => {
		if (!hasSelection) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (covered.current) return;
			event.preventDefault();
			setHeld(null);
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [hasSelection]);
	useOutsideClick(hasSelection, (target, event) => {
		if (covered.current || !target.isConnected) return;
		if (barRef.current?.contains(target)) return;
		if (isGutter(target) || target.closest(INTERACTIVE)) return;
		event.stopPropagation();
		setHeld(null);
	});

	const copySelection = () => {
		if (!selection || !diff || diff.omitted) return "";
		return selectionCopyText(selection.description, selection.selected, {
			old: diff.old_content,
			new: diff.new_content,
		});
	};
	const askAgent = () => {
		if (!selection) return;
		const { view } = selection.range;
		const body = bodyRef.current;
		// Read from the page: a gap the reader has not expanded is lines they
		// have not read, and the draft says how many rather than quoting them.
		const shown = body ? shownLineKeys(body, view) : null;
		void prefill.insert(
			selectionPrefillText({
				path,
				selected: selection.selected,
				view,
				description: selection.description,
				source,
				isShown: (row) =>
					row.hunk !== undefined ||
					!shown ||
					shown.has(rowKey(row, view) ?? ""),
			}),
		);
	};

	const bar = selection && (
		<LineSelectionBar
			label={capitalize(selection.description.label)}
			copyText={copySelection}
			onAsk={askAgent}
			asking={prefill.isPending}
			onClear={() => setHeld(null)}
			onFocusChange={(focused) => {
				barHasFocus.current = focused;
			}}
			copyRef={copyRef}
			barRef={barRef}
		/>
	);

	return {
		selectHunk,
		onLinePress,
		selectedLines,
		/** For a live region of the page's: what a gutter press selected. */
		announcement,
		bar,
	};
}
