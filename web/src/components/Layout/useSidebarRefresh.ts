import { useContext, useEffect, useRef } from "react";
import { SidebarContext } from "./SidebarContext";

export function useSidebarRefresh(tabId: string, onRefresh?: () => void) {
	const context = useContext(SidebarContext);
	if (!context) {
		throw new Error(
			"useSidebarRefresh must be used within a SidebarContext provider",
		);
	}

	const { activeTab, refreshSignal } = context;
	const isActive = activeTab === tabId;
	const onRefreshRef = useRef(onRefresh);
	onRefreshRef.current = onRefresh;
	const prevSignalRef = useRef(refreshSignal);

	useEffect(() => {
		if (
			isActive &&
			refreshSignal !== prevSignalRef.current &&
			onRefreshRef.current
		) {
			onRefreshRef.current();
		}
		prevSignalRef.current = refreshSignal;
	}, [refreshSignal, isActive]);

	return { isActive };
}
