import { PanelLeftClose, X } from "lucide-react";
import { useSidebarContainer } from "../../../lib/sidebarContainerContext";

export default function SidebarHeader() {
	const { onClose, isExpanded } = useSidebarContainer();

	// Both tiers can take the sidebar off screen: the drawer closes, the column
	// collapses. The column's button only exists while it is expanded, so its
	// `aria-expanded` has one value.
	return (
		<div className="flex items-center justify-between border-b border-th-border px-4 py-3">
			<h2 className="text-sm font-semibold text-th-text-primary">
				Custom Sidebar
			</h2>
			<button
				type="button"
				onClick={onClose}
				className="flex size-9 items-center justify-center rounded text-th-text-muted hover:text-th-text-primary pointer-coarse:size-11"
				{...(isExpanded
					? { "aria-label": "Collapse sidebar", "aria-expanded": true }
					: { "aria-label": "Close sidebar" })}
			>
				{isExpanded ? (
					<PanelLeftClose className="size-4" aria-hidden="true" />
				) : (
					<X className="size-4" aria-hidden="true" />
				)}
			</button>
		</div>
	);
}
