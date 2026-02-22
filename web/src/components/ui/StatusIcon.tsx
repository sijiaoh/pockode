import { Circle, CircleCheck, CircleDot, CirclePause } from "lucide-react";
import type { WorkStatus } from "../../types/work";

interface StatusIconProps {
	status: WorkStatus;
	size?: "sm" | "default";
}

export default function StatusIcon({
	status,
	size = "default",
}: StatusIconProps) {
	const base = size === "sm" ? "size-3 shrink-0" : "size-3.5 shrink-0";
	switch (status) {
		case "open":
			return <Circle className={`${base} text-th-text-muted`} />;
		case "in_progress":
			return <CircleDot className={`${base} text-th-accent`} />;
		case "needs_input":
			return <CirclePause className={`${base} text-th-warning`} />;
		case "done":
			return <CircleCheck className={`${base} text-th-success`} />;
		case "closed":
			return <CircleCheck className={`${base} text-th-text-muted`} />;
	}
}
