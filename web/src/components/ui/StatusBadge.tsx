import type { WorkStatus } from "../../types/work";

export const statusLabels: Record<WorkStatus, string> = {
	open: "Open",
	in_progress: "In Progress",
	waiting: "Waiting",
	needs_input: "Needs Input",
	stopped: "Stopped",
	closed: "Closed",
};

/**
 * One shape for all six: a semantic border carries the hue and the tint sits
 * behind it.
 *
 * Every status used to tint and letter itself in the same token, which fails AA
 * in all five light variants — worst for `needs_input`, but no status cleared
 * it. Lowering the tint cannot fix that, so the hue moved to the border, where
 * it only owes the non-text floor. `needs_input` is the one that still reads
 * faint: `--th-warning` is too pale in light variants to clear even that floor,
 * and choosing a new value for it is a token-level change, not this one. Its
 * label is legible regardless, which it was not before.
 *
 * `open` and `closed` have no hue to move: their fill is `bg-th-bg-tertiary`
 * rather than a tint, and `border-th-border` on it never reaches 1.3:1, so the
 * label is the only weight they have. It is `text-th-text-secondary` (6.90:1
 * at worst) and not the body colour the other four take — a status is the
 * least important thing in a row, and one that is finished or not yet started
 * should not read as loudly as one that is running. That is what the old
 * `text-th-text-muted` was saying at 2.23:1, and the reason it had to be
 * replaced rather than kept.
 */
const styles: Record<WorkStatus, string> = {
	open: "border-th-border bg-th-bg-tertiary text-th-text-secondary",
	in_progress: "border-th-accent bg-th-accent/10 text-th-text-primary",
	waiting: "border-th-accent bg-th-accent/10 text-th-text-primary",
	needs_input: "border-th-warning bg-th-warning/10 text-th-text-primary",
	stopped: "border-th-error bg-th-error/10 text-th-text-primary",
	closed: "border-th-border bg-th-bg-tertiary text-th-text-secondary",
};

export default function StatusBadge({ status }: { status: WorkStatus }) {
	return (
		<span
			className={`rounded-full border px-2 py-0.5 text-xs ${styles[status]}`}
		>
			{statusLabels[status]}
		</span>
	);
}
