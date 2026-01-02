import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./Sidebar";
import { SidebarContext } from "./SidebarContext";

export interface TabConfig {
	id: string;
	label: string;
	icon: LucideIcon;
}

interface Props {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	tabs: TabConfig[];
	defaultTab: string;
	isDesktop: boolean;
	children: React.ReactNode;
}

/**
 * Generic tabbed sidebar container that manages refresh timing.
 *
 * Refresh signals are triggered when:
 * - Sidebar opens (for current active tab)
 * - Tab is switched (for newly active tab)
 *
 * Tab content should use useSidebarRefresh() to subscribe to refresh signals.
 */
function TabbedSidebar({
	isOpen,
	onClose,
	title,
	tabs,
	defaultTab,
	isDesktop,
	children,
}: Props) {
	const [activeTab, setActiveTab] = useState(defaultTab);
	const [refreshSignal, setRefreshSignal] = useState(0);
	const prevOpenRef = useRef(isOpen);

	useEffect(() => {
		if (isOpen && !prevOpenRef.current) {
			setRefreshSignal((s) => s + 1);
		}
		prevOpenRef.current = isOpen;
	}, [isOpen]);

	const handleTabChange = (tabId: string) => {
		if (tabId === activeTab) return;
		setActiveTab(tabId);
		setRefreshSignal((s) => s + 1);
	};

	const contextValue = useMemo(
		() => ({ activeTab, refreshSignal }),
		[activeTab, refreshSignal],
	);

	return (
		<SidebarContext.Provider value={contextValue}>
			<Sidebar
				isOpen={isOpen}
				onClose={onClose}
				title={title}
				isDesktop={isDesktop}
			>
				{/* Tab bar */}
				<div className="flex border-b border-th-border">
					{tabs.map((tab) => {
						const Icon = tab.icon;
						return (
							<button
								key={tab.id}
								type="button"
								onClick={() => handleTabChange(tab.id)}
								className={`flex flex-1 items-center justify-center gap-1.5 px-4 py-3 text-sm font-medium transition-colors ${
									activeTab === tab.id
										? "border-b-2 border-th-accent text-th-accent"
										: "text-th-text-muted hover:text-th-text-primary"
								}`}
							>
								<Icon className="h-4 w-4" aria-hidden="true" />
								{tab.label}
							</button>
						);
					})}
				</div>

				{/* Tab content */}
				{children}
			</Sidebar>
		</SidebarContext.Provider>
	);
}

export default TabbedSidebar;
