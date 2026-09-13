import type { ReactNode } from "react";
import type { TokenUsage } from "../../types/message";
import type { WorkType, WorkUsage } from "../../types/work";
import { formatCost, formatTokens, totalTokens } from "../../utils/tokens";

interface Props {
	/** Names the own column: the user is looking at this story, or this task. */
	type: WorkType;
	usage: WorkUsage;
}

const ownLabels: Record<WorkType, string> = {
	story: "This story",
	task: "This task",
};

interface Column {
	key: string;
	/** Absent on the lone column, which has nothing to be distinguished from. */
	header?: string;
	usage: TokenUsage | undefined;
	/** The subtree figure is what the page is about; the own figure is context. */
	isTotal: boolean;
}

/**
 * One figure, or the fact that nobody reported one.
 *
 * The em dash is a shape rather than a word, and an `aria-label` on a bare span
 * is not reliably announced — so the meaning ships as text beside it. Never a
 * `0`: that would claim an agent reported zero when it reported nothing.
 */
function Figure({
	value,
	isTotal,
}: {
	value: string | null;
	isTotal: boolean;
}) {
	if (value === null) {
		return (
			<span className="text-right text-th-text-muted">
				<span aria-hidden="true">—</span>
				<span className="sr-only">not reported</span>
			</span>
		);
	}

	return (
		<span
			className={`text-right tabular-nums ${
				isTotal ? "font-medium text-th-text-primary" : "text-th-text-secondary"
			}`}
		>
			{value}
		</span>
	);
}

function tokensCell(usage: TokenUsage | undefined): string | null {
	return usage ? formatTokens(totalTokens(usage)) : null;
}

function costCell(column: Column, unpricedCount: number): string | null {
	const cost = column.usage?.cost_usd;
	if (cost === undefined) return null;
	// A trailing `+` where sessions in scope spent tokens without a price: a tree
	// mixing an agent that prices with one that never does would otherwise print
	// a figure that looks complete. The same convention the badge counts use.
	const floor = column.isTotal && unpricedCount > 0 ? "+" : "";
	return `${formatCost(cost)}${floor}`;
}

/** Contents, so the cells land in the parent grid's columns rather than in a row of their own. */
function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="contents">
			<span className="text-th-text-secondary">{label}</span>
			{children}
		</div>
	);
}

/**
 * What a work item and its subtree have spent, between Steps and Tasks — a fact
 * about this item, above the list of items it aggregates.
 *
 * Figures are abbreviated here (`1.2M`): a subtree total is read as a
 * proportion, and three columns of grouped exact counts do not fit a 360px
 * viewport. The exact ones are one Open Chat away, in the session info panel.
 */
function WorkUsageSection({ type, usage }: Props) {
	const { own, total, descendant_count: descendantCount } = usage;
	if (!own && !total) return null;

	// The shape of the tree decides this, not the numbers: keying it off
	// `total > own` would grow a second column the moment a task's first turn
	// landed, reorganising the page under the user as a side effect of an agent
	// working.
	const twoColumns = descendantCount > 0;
	const columns: Column[] = twoColumns
		? [
				{
					key: "own",
					header: ownLabels[type],
					usage: own,
					isTotal: false,
				},
				{
					key: "total",
					header: `Incl. ${descendantCount} ${descendantCount === 1 ? "task" : "tasks"}`,
					usage: total,
					isTotal: true,
				},
			]
		: // With no descendants the two figures are the same number, so only one is
			// worth a column — and with one column there is nothing to label.
			[{ key: "total", usage: total ?? own, isTotal: true }];

	const unpricedCount = usage.unpriced_session_count ?? 0;
	const showCost = columns.some((c) => c.usage?.cost_usd !== undefined);

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
				Usage
			</h3>
			{/* Fixed columns with the figures right-aligned in them is what makes the
			    pair comparable at a glance; two left-aligned numbers of different
			    widths are not. */}
			<div
				className={`grid ${twoColumns ? "grid-cols-[auto_1fr_1fr]" : "grid-cols-[auto_1fr]"} gap-x-3 gap-y-1 rounded-lg bg-th-bg-secondary px-3 py-2 text-sm`}
			>
				{twoColumns && (
					<div className="contents">
						<span />
						{columns.map((column) => (
							<span
								key={column.key}
								className="text-right text-[10px] uppercase text-th-text-muted"
							>
								{column.header}
							</span>
						))}
					</div>
				)}
				<Row label="Tokens">
					{columns.map((column) => (
						<Figure
							key={column.key}
							value={tokensCell(column.usage)}
							isTotal={column.isTotal}
						/>
					))}
				</Row>
				{/* Absent entirely where no agent in scope reported a price — not a
				    dash, and never a computed `$0.00`. */}
				{showCost && (
					<Row label="Cost">
						{columns.map((column) => (
							<Figure
								key={column.key}
								value={costCell(column, unpricedCount)}
								isTotal={column.isTotal}
							/>
						))}
					</Row>
				)}
			</div>
			{twoColumns && (
				<p className="mt-1 text-xs text-th-text-muted">
					Total covers this {type} and every task beneath it.
				</p>
			)}
			{/* Tied to the cost row, because it explains that row's `+`. With no
			    cost anywhere there is no figure for it to qualify, and the sentence
			    would point at something that is not on screen. */}
			{showCost && unpricedCount > 0 && (
				<p className="mt-1 text-xs text-th-text-muted">
					{unpricedCount === 1
						? "Price is missing for 1 session — its agent does not report one."
						: `Price is missing for ${unpricedCount} sessions — their agent does not report one.`}
				</p>
			)}
		</div>
	);
}

export default WorkUsageSection;
