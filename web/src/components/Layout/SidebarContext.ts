// Sidebar tab state (activeTab, refreshSignal) used by both TabbedSidebar
// and custom SidebarContent components via useSidebarRefresh.
// Separate from sidebarContainerContext which provides container-level props
// (onClose, isDesktop) for extension SidebarContent components.
import { createContext } from "react";

export interface SidebarContextValue {
	activeTab: string;
	refreshSignal: number;
}

export const SidebarContext = createContext<SidebarContextValue | null>(null);
