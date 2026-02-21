import { Circle, CircleCheck, CircleDot } from "lucide-react";
import type { WorkStatus } from "../../types/work";

interface StatusIconProps {
	status: WorkStatus;
	className?: string;
}

export default function StatusIcon({
	status,
	className = "",
}: StatusIconProps) {
	const base = className
		? `size-3.5 shrink-0 ${className}`
		: "size-3.5 shrink-0";
	switch (status) {
		case "open":
			return <Circle className={`${base} text-th-text-muted`} />;
		case "in_progress":
			return <CircleDot className={`${base} text-th-accent`} />;
		case "done":
			return <CircleCheck className={`${base} text-th-warning`} />;
		case "closed":
			return <CircleCheck className={`${base} text-th-success`} />;
	}
}
