import { Circle, CircleCheck, CircleDot, CircleStop } from "lucide-react";
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
		case "active":
			return <CircleDot className={`${base} text-th-accent`} />;
		case "stopped":
			return <CircleStop className={`${base} text-th-error`} />;
		case "closed":
			return <CircleCheck className={`${base} text-th-text-muted`} />;
	}
}
