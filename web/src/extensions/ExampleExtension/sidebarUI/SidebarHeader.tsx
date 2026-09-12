import { X } from "lucide-react";
import { useSidebarContainer } from "../../../lib/sidebarContainerContext";

export default function SidebarHeader() {
	const { onClose, isExpanded } = useSidebarContainer();

	return (
		<div className="flex items-center justify-between border-b border-th-border px-4 py-3">
			<h2 className="text-sm font-semibold text-th-text-primary">
				Custom Sidebar
			</h2>
			{!isExpanded && (
				<button
					type="button"
					onClick={onClose}
					className="flex size-9 items-center justify-center rounded text-th-text-muted hover:text-th-text-primary pointer-coarse:size-11"
					aria-label="Close sidebar"
				>
					<X className="size-4" />
				</button>
			)}
		</div>
	);
}
