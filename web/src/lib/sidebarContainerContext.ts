// Container-level context for custom SidebarContent registered via extensions.
// Provides isOpen, onClose and isExpanded so deeply nested extension
// components can control the sidebar without prop drilling.
// Separate from Layout/SidebarContext which manages TabbedSidebar tab state.
import { createContext, useContext } from "react";

export interface SidebarContainerContextValue {
	/** Whether the sidebar is on screen: the drawer is open, or the column is not collapsed. */
	isOpen: boolean;
	/** Takes the sidebar off screen: closes the drawer, or collapses the column. */
	onClose: () => void;
	/** The width tier — whether the sidebar is a column rather than a drawer — not whether it is visible. */
	isExpanded: boolean;
}

export const SidebarContainerContext =
	createContext<SidebarContainerContextValue | null>(null);

export function useSidebarContainer(): SidebarContainerContextValue {
	const ctx = useContext(SidebarContainerContext);
	if (!ctx) {
		throw new Error(
			"useSidebarContainer must be used within SidebarContainerContext.Provider",
		);
	}
	return ctx;
}
