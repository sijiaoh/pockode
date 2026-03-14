// Container-level context for custom SidebarContent registered via extensions.
// Provides onClose and isDesktop so deeply nested extension components can
// control the sidebar without prop drilling.
// Separate from Layout/SidebarContext which manages TabbedSidebar tab state.
import { createContext, useContext } from "react";

export interface SidebarContainerContextValue {
	isOpen: boolean;
	onClose: () => void;
	isDesktop: boolean;
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
