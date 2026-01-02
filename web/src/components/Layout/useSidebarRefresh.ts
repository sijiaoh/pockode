import { useContext, useEffect, useRef } from "react";
import { SidebarContext } from "./SidebarContext";

/**
 * Hook for sidebar tab content to subscribe to refresh signals.
 *
 * @param tabId - The tab identifier this content belongs to
 * @param onRefresh - Callback to execute when refresh is triggered
 * @returns { isActive } - Whether this tab is currently active
 */
export function useSidebarRefresh(tabId: string, onRefresh: () => void) {
	const context = useContext(SidebarContext);
	if (!context) {
		throw new Error("useSidebarRefresh must be used within TabbedSidebar");
	}

	const { activeTab, refreshSignal } = context;
	const isActive = activeTab === tabId;
	const onRefreshRef = useRef(onRefresh);
	onRefreshRef.current = onRefresh;
	const prevSignalRef = useRef(refreshSignal);

	useEffect(() => {
		if (isActive && refreshSignal !== prevSignalRef.current) {
			onRefreshRef.current();
		}
		prevSignalRef.current = refreshSignal;
	}, [refreshSignal, isActive]);

	return { isActive };
}
