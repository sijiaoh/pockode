import type { WorkStatus } from "../../types/work";

export const statusLabels: Record<WorkStatus, string> = {
	open: "Open",
	active: "Active",
	stopped: "Stopped",
	closed: "Closed",
};

/**
 * One shape for all four: a semantic border carries the hue and the tint sits
 * behind it.
 *
 * Every status used to tint and letter itself in the same token, which fails AA
 * in all light variants. Lowering the tint cannot fix that, so the hue moved to
 * the border, where it only owes the non-text floor. The warning tone — which
 * this badge no longer uses, but the activity badge that replaces it will — is
 * the one that still reads faint even there: `--th-warning` is too pale in light
 * variants, and choosing a new value for it is a token-level change.
 *
 * `open` and `closed` have no hue to move: their fill is `bg-th-bg-tertiary`
 * rather than a tint, and `border-th-border` on it never reaches 1.3:1, so the
 * label is the only weight they have. It is `text-th-text-secondary` (6.90:1
 * at worst) and not the body colour the other two take — a status is the
 * least important thing in a row, and one that is finished or not yet started
 * should not read as loudly as one that is running. That is what the old
 * `text-th-text-muted` was saying at 2.23:1, and the reason it had to be
 * replaced rather than kept.
 */
const styles: Record<WorkStatus, string> = {
	open: "border-th-border bg-th-bg-tertiary text-th-text-secondary",
	active: "border-th-accent bg-th-accent/10 text-th-text-primary",
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
