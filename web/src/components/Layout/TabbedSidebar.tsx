import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BadgeCount, BadgeDot, type BadgeDotTone } from "../ui";
import Sidebar from "./Sidebar";
import { SidebarContext } from "./SidebarContext";

export interface TabConfig {
	id: string;
	label: string;
	icon: LucideIcon;
	showBadge?: boolean;
	/**
	 * What that dot is saying, when it is not the usual "something arrived
	 * here". Left out by every tab but the one whose badge means a person is
	 * being waited on (docs/lifecycle-ui.md §4).
	 */
	badgeTone?: BadgeDotTone;
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
	/** Render function for header slot, receives onClose and isExpanded for the drawer's close or the column's collapse button */
	renderHeader?: (props: {
		onClose: () => void;
		isExpanded: boolean;
	}) => React.ReactNode;
}

/**
 * Generic tabbed sidebar container that manages refresh timing.
 *
 * Refresh signals are triggered when:
 * - Sidebar comes on screen (drawer opens, or column expands)
 * - Tab is clicked (including the active tab)
 *
 * Tab content should use useSidebarRefresh() to subscribe to refresh signals.
 *
 * The bar follows the WAI-ARIA Tabs pattern with automatic activation: every
 * tab's content is already mounted and only hidden, so selection can follow
 * focus at no cost. There is one tabpanel rather than one per tab because the
 * contents hide themselves; it is relabelled by whichever tab is selected.
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
	const idPrefix = useId();
	const tabId = (id: string) => `${idPrefix}-tab-${id}`;
	const panelId = `${idPrefix}-panel`;

	// A tab can be taken away while it is open (the Git tab, when the project
	// stops being a repository). Falling back in state rather than only in what
	// is drawn keeps the tab from reopening itself when it comes back.
	if (activeTab !== defaultTab && !tabs.some((tab) => tab.id === activeTab)) {
		setActiveTab(defaultTab);
	}
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

	const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
		let next: number;
		switch (e.key) {
			case "ArrowRight":
				next = (index + 1) % tabs.length;
				break;
			case "ArrowLeft":
				next = (index - 1 + tabs.length) % tabs.length;
				break;
			case "Home":
				next = 0;
				break;
			case "End":
				next = tabs.length - 1;
				break;
			default:
				return;
		}
		e.preventDefault();
		const nextId = tabs[next].id;
		document.getElementById(tabId(nextId))?.focus();
		handleTabClick(nextId);
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
				<div role="tablist" className="flex border-b border-th-border">
					{tabs.map((tab, index) => {
						const Icon = tab.icon;
						const isSelected = activeTab === tab.id;
						return (
							<button
								key={tab.id}
								type="button"
								role="tab"
								id={tabId(tab.id)}
								aria-selected={isSelected}
								aria-controls={panelId}
								tabIndex={isSelected ? 0 : -1}
								onClick={() => handleTabClick(tab.id)}
								onKeyDown={(e) => handleTabKeyDown(e, index)}
								// Every tab carries the 2px border, transparent unless selected:
								// a border on the selected tab alone sat its icon 1px higher
								// than its neighbours, which the row stretched to match. Only the
								// text colour transitions, so the underline still snaps in.
								className={`relative flex min-h-11 flex-1 items-center justify-center border-b-2 py-3 transition-[color] ${
									isSelected
										? "border-th-accent text-th-accent"
										: "border-transparent text-th-text-muted hover:text-th-text-primary"
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
										tone={tab.badgeTone}
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

				<div
					role="tabpanel"
					id={panelId}
					aria-labelledby={tabId(activeTab)}
					className="flex min-h-0 flex-1 flex-col"
				>
					{children}
				</div>
			</Sidebar>
		</SidebarContext.Provider>
	);
}

export default TabbedSidebar;
