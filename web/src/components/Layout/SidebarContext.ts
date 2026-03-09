// Internal context for TabbedSidebar tab state (activeTab, refreshSignal).
// Separate from sidebarContainerContext which provides container-level props
// (onClose, isDesktop) for extension SidebarContent components.
import { createContext } from "react";

export interface SidebarContextValue {
	activeTab: string;
	refreshSignal: number;
}

export const SidebarContext = createContext<SidebarContextValue | null>(null);
