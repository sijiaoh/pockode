import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BadgeCount, BadgeDot } from "../ui";
import Sidebar from "./Sidebar";
import { SidebarContext } from "./SidebarContext";

export interface TabConfig {
	id: string;
	label: string;
	icon: LucideIcon;
	showBadge?: boolean;
	/**
	 * Number badge plus what the number means, spoken after the tab label.
	 * Left out entirely while there is no number to show. A tab wants one badge
	 * or the other — a dot and a pill would land on top of each other.
	 */
	countBadge?: { value: number; label: string };
}

interface Props {
	isOpen: boolean;
	onClose: () => void;
	tabs: TabConfig[];
	defaultTab: string;
	isExpanded: boolean;
	children: React.ReactNode;
	/** Render function for header slot, receives onClose and isExpanded for mobile close button */
	renderHeader?: (props: {
		onClose: () => void;
		isExpanded: boolean;
	}) => React.ReactNode;
}

/**
 * Generic tabbed sidebar container that manages refresh timing.
 *
 * Refresh signals are triggered when:
 * - Sidebar opens
 * - Tab is clicked (including the active tab)
 *
 * Tab content should use useSidebarRefresh() to subscribe to refresh signals.
 */
function TabbedSidebar({
	isOpen,
	onClose,
	tabs,
	defaultTab,
	isExpanded,
	children,
	renderHeader,
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

	const handleTabClick = (tabId: string) => {
		if (tabId !== activeTab) {
			setActiveTab(tabId);
		}
		setRefreshSignal((s) => s + 1);
	};

	const contextValue = useMemo(
		() => ({ activeTab, refreshSignal }),
		[activeTab, refreshSignal],
	);

	return (
		<SidebarContext.Provider value={contextValue}>
			<Sidebar isOpen={isOpen} onClose={onClose} isExpanded={isExpanded}>
				{/* Header slot */}
				{renderHeader?.({ onClose, isExpanded })}

				{/* Tab bar */}
				<div className="flex border-b border-th-border">
					{tabs.map((tab) => {
						const Icon = tab.icon;
						return (
							<button
								key={tab.id}
								type="button"
								onClick={() => handleTabClick(tab.id)}
								className={`relative flex min-h-11 flex-1 items-center justify-center py-3 transition-colors ${
									activeTab === tab.id
										? "border-b-2 border-th-accent text-th-accent"
										: "text-th-text-muted hover:text-th-text-primary"
								}`}
								aria-label={
									tab.countBadge
										? `${tab.label}, ${tab.countBadge.label}`
										: tab.label
								}
							>
								{/* Both badges anchor to the 20px icon box, not to the tab:
								    a pill that widens with its digits would drift if it were
								    positioned off a percentage of the button. */}
								<span className="relative flex">
									<Icon className="h-5 w-5" />
									<BadgeDot
										show={!!tab.showBadge}
										className="-top-0.5 -right-0.5"
									/>
									<BadgeCount
										count={tab.countBadge?.value}
										className="-top-1.5 -right-2.5"
									/>
								</span>
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
