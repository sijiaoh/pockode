import { createContext } from "react";

export interface SidebarContextValue {
	activeTab: string;
	refreshSignal: number;
}

export const SidebarContext = createContext<SidebarContextValue | null>(null);
