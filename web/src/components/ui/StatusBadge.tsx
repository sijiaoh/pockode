import type { WorkStatus } from "../../types/work";

export const statusLabels: Record<WorkStatus, string> = {
	open: "Open",
	in_progress: "In Progress",
	waiting: "Waiting",
	needs_input: "Needs Input",
	stopped: "Stopped",
	done: "Done",
	closed: "Closed",
};

const styles: Record<WorkStatus, string> = {
	open: "bg-th-bg-tertiary text-th-text-muted",
	in_progress: "bg-th-accent/10 text-th-accent",
	waiting: "bg-th-accent/10 text-th-accent",
	needs_input: "bg-th-warning/10 text-th-warning",
	stopped: "bg-th-error/10 text-th-error",
	done: "bg-th-success/10 text-th-success",
	closed: "bg-th-bg-tertiary text-th-text-muted",
};

export default function StatusBadge({ status }: { status: WorkStatus }) {
	return (
		<span className={`rounded-full px-2 py-0.5 text-xs ${styles[status]}`}>
			{statusLabels[status]}
		</span>
	);
}
