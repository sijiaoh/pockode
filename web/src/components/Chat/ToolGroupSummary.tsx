import { Ban, Check } from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
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

/**
 * The richest form of the line that fits the width the text column actually
 * has — not a character budget, which could only disagree with the screen.
 *
 * Every form's natural width is measured once per content, from copies drawn
 * for that one layout pass and gone before paint — left in, their words would
 * be found, selected and copied as the row's own. A resize then only compares
 * numbers, and a web font arriving measures again. Until a width is known
 * (first paint, jsdom) the richest is drawn and `truncate` covers it; a width
 * of 0 — the list is in a collapsed Process — measures nothing, and a reveal
 * re-fits from there.
 *
 * Both sides are read with `getBoundingClientRect`: `clientWidth` rounds, and
 * a form a fraction too wide is its last name cut to `…`.
 */
function FittedLine({ forms }: { forms: FormSegment[][] }) {
	const columnRef = useRef<HTMLSpanElement>(null);
	const copiesRef = useRef<HTMLSpanElement>(null);
	// A group re-derives on every render; only new words are worth measuring.
	const content = JSON.stringify(forms);
	const [widths, setWidths] = useState<{
		content: string;
		/** Null when measured out of sight, where every width reads 0. */
		values: number[] | null;
	}>();
	const [available, setAvailable] = useState(0);
	const measuring = widths?.content !== content;

	useLayoutEffect(() => {
		const column = columnRef.current;
		const copies = copiesRef.current;
		if (!measuring || !column || !copies) return;
		const width = column.getBoundingClientRect().width;
		const shown = width > 0;
		setWidths({
			content,
			values: shown
				? [...copies.children].map((copy) => copy.getBoundingClientRect().width)
				: null,
		});
		if (shown) setAvailable(width);
	}, [measuring, content]);

	useLayoutEffect(() => {
		const column = columnRef.current;
		if (!column) return;
		const observer = new ResizeObserver(() => {
			const width = column.getBoundingClientRect().width;
			if (width === 0) return;
			setAvailable(width);
			// Measured while out of sight: measure again now that it shows.
			setWidths((last) => (last?.values ? last : undefined));
		});
		observer.observe(column);
		// The column's width does not follow its text, so a font swap
		// (`display=swap`) changes every form's width without resizing it.
		const remeasure = () => setWidths(undefined);
		document.fonts?.addEventListener("loadingdone", remeasure);
		return () => {
			observer.disconnect();
			document.fonts?.removeEventListener("loadingdone", remeasure);
		};
	}, []);

	const values = widths?.content === content ? widths.values : null;
	let pick = 0;
	if (values && available > 0) {
		const fits = values.findIndex((width) => width <= available);
		pick = fits === -1 ? values.length - 1 : fits;
	}
	return (
		<span
			ref={columnRef}
			className="relative block min-w-0 flex-1 truncate text-th-text-secondary"
		>
			<FormLine form={forms[pick]} />
			{measuring && (
				<span
					ref={copiesRef}
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
