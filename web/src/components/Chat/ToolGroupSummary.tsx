import { Ban, Check } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import {
	type FormSegment,
	type GroupSummary,
	summaryForms,
} from "../../lib/toolGroups";
import { RowButton, RunningGlyph, ToolMeta } from "./ToolRow";

interface Props {
	summary: GroupSummary;
	expanded: boolean;
	onToggle: () => void;
}

const MUTED = "text-th-text-muted";

function FormLine({ form }: { form: FormSegment[] }) {
	return form.map((segment, index) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: a line's segments have no identity beyond their place
		<Fragment key={index}>
			{index > 0 && <span className={MUTED}> · </span>}
			{segment.lead}
			{segment.names.map((name, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: two spellings of one path can share a name
				<Fragment key={at}>
					{at > 0 ? (
						<span className={MUTED}>, </span>
					) : segment.counted ? (
						<span className={MUTED}>: </span>
					) : (
						" "
					)}
					<span className="font-mono">{name.text}</span>
					{name.times > 1 && <span className={MUTED}> ×{name.times}</span>}
				</Fragment>
			))}
		</Fragment>
	));
}

type Watcher = (entry: ResizeObserverEntry) => void;
const watchers = new Map<Element, Watcher>();
let sizes: ResizeObserver | undefined;

/**
 * One observer for every summary line. It reports inside the frame's own
 * layout, so fitting never forces one; and what it reports is applied in a
 * single synchronous commit before that frame paints — the lines a page
 * landing or a resize refits all at once, and none is seen unfitted.
 * Every watcher reads before any of them renders, so each read lands on the
 * layout just done.
 */
function watchSize(element: Element, watcher: Watcher) {
	sizes ??= new ResizeObserver((entries) => {
		flushSync(() => {
			for (const entry of entries) watchers.get(entry.target)?.(entry);
		});
	});
	watchers.set(element, watcher);
	sizes.observe(element);
	return () => {
		watchers.delete(element);
		sizes?.unobserve(element);
	};
}

/**
 * The richest form of the line that fits the width the text column actually
 * has — not a character budget, which could only disagree with the screen.
 *
 * Every form's natural width is measured once per content, from copies drawn
 * for that one layout pass and gone before paint — left in, their words would
 * be found, selected and copied as the row's own. They are read when the
 * observer reports them, not in an effect: an effect's read would force the
 * whole transcript's layout in the middle of every record that changes a
 * group, where the observer reads the layout the frame does anyway — once a
 * frame, however many records arrived in it. So a line whose words and width
 * are as they were does nothing at all, and a resize only compares numbers. A
 * web font arriving measures again. Until the column has a width (first paint,
 * jsdom) the richest is drawn and `truncate` covers it; while it has none —
 * the list is in a collapsed Process — nothing is measured, and a reveal fits
 * from there.
 *
 * Both sides are read with `getBoundingClientRect`: `clientWidth` rounds, and
 * a form a fraction too wide is its last name cut to `…`.
 */
function FittedLine({ forms }: { forms: FormSegment[][] }) {
	// A group re-derives on every render; only new words are worth measuring.
	const content = JSON.stringify(forms);
	const [widths, setWidths] = useState<{ content: string; values: number[] }>();
	const [column, setColumn] = useState({ shown: false, available: 0 });
	const measuring = column.shown && widths?.content !== content;

	const observeColumn = useCallback(
		(element: HTMLSpanElement) =>
			watchSize(element, () => {
				const width = element.getBoundingClientRect().width;
				// Out of sight keeps the last width, so the pick holds.
				setColumn((last) => {
					if (width === 0) return last.shown ? { ...last, shown: false } : last;
					if (last.shown && last.available === width) return last;
					return { shown: true, available: width };
				});
			}),
		[],
	);

	// Keyed on the words, so new words observe the copies afresh: an
	// observation reports once on starting, even when the copies' box came
	// out the size it was.
	const observeCopies = useCallback(
		(element: HTMLSpanElement) =>
			watchSize(element, (entry) => {
				// Not rendered after all (hidden since): every width would read
				// 0. Its showing again is a resize, and reports then.
				if (entry.contentRect.width === 0) return;
				setWidths({
					content,
					values: [...element.children].map(
						(copy) => copy.getBoundingClientRect().width,
					),
				});
			}),
		[content],
	);

	useEffect(() => {
		// The column's width does not follow its text, so a font swap
		// (`display=swap`) changes every form's width without resizing it.
		const remeasure = () => setWidths(undefined);
		document.fonts?.addEventListener("loadingdone", remeasure);
		return () => document.fonts?.removeEventListener("loadingdone", remeasure);
	}, []);

	const values = widths?.content === content ? widths.values : null;
	let pick = 0;
	if (values && column.available > 0) {
		const fits = values.findIndex((width) => width <= column.available);
		pick = fits === -1 ? values.length - 1 : fits;
	}
	return (
		<span
			ref={observeColumn}
			className="relative block min-w-0 flex-1 truncate text-th-text-secondary"
		>
			<FormLine form={forms[pick]} />
			{measuring && (
				<span
					ref={observeCopies}
					aria-hidden
					className="pointer-events-none invisible absolute top-0 left-0 flex flex-col items-start"
				>
					{forms.map((copy, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the forms are a ladder, ordered by width
						<span key={index} className="w-max whitespace-nowrap">
							<FormLine form={copy} />
						</span>
					))}
				</span>
			)}
		</span>
	);
}

/**
 * The one row a run of calls folds into (docs/tool-call-ui.md#groups). Never
 * red and never green: red belongs to the failed rows pinned under it, and a
 * group of successes is the transcript's ordinary case. No accent title
 * either — that is what tells it apart from a tool row, which always opens on
 * one. One line in every form, so running and settled are the same height.
 */
export function ToolGroupSummary({ summary, expanded, onToggle }: Props) {
	const forms = summaryForms(summary);
	const { current } = summary;
	if (current) {
		return (
			<RowButton
				expanded={expanded}
				onToggle={onToggle}
				glyph={<RunningGlyph label="Tool calls running" />}
			>
				{/* Every word of it moves, so it stays out of the button's
				    accessible name; the spinner says what is going on. */}
				<span aria-hidden className="flex items-baseline gap-1.5">
					<FittedLine forms={forms} />
					<ToolMeta run={current} />
				</span>
			</RowButton>
		);
	}

	// A card waits on the user while folded calls still run: neither busy nor
	// done, so no spinner and no tick. The present tense leading the line is
	// what says "still running".
	const stillRunning = summary.segments.some(
		(segment) => segment.tense === "present",
	);
	const Icon = summary.interrupted > 0 ? Ban : Check;
	return (
		<RowButton
			expanded={expanded}
			onToggle={onToggle}
			glyph={
				stillRunning ? (
					<span className="mt-0.5 size-3 shrink-0" />
				) : (
					<Icon
						className={`mt-0.5 size-3 shrink-0 ${MUTED}`}
						aria-label={summary.interrupted > 0 ? "interrupted" : "done"}
					/>
				)
			}
		>
			<span className="flex">
				<FittedLine forms={forms} />
			</span>
		</RowButton>
	);
}
