import { MessageSquare, StickyNote } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SidebarContext } from "../../../components/Layout/SidebarContext";
import { useSidebarContainer } from "../../../lib/sidebarContainerContext";
import NotesTab from "./NotesTab";
import SessionsTab from "./SessionsTab";
import SidebarHeader from "./SidebarHeader";

const TABS = [
	{ id: "sessions", label: "Sessions", Icon: MessageSquare },
	{ id: "notes", label: "Notes", Icon: StickyNote },
] as const;

export default function CustomSidebarContent() {
	const { isOpen } = useSidebarContainer();
	const [activeTab, setActiveTab] = useState<string>("sessions");
	const [refreshSignal, setRefreshSignal] = useState(0);
	const prevOpenRef = useRef(isOpen);

	useEffect(() => {
		if (isOpen && !prevOpenRef.current) {
			setRefreshSignal((s) => s + 1);
		}
		prevOpenRef.current = isOpen;
	}, [isOpen]);

	const contextValue = useMemo(
		() => ({ activeTab, refreshSignal }),
		[activeTab, refreshSignal],
	);

	const handleTabClick = (tabId: string) => {
		if (tabId !== activeTab) {
			setActiveTab(tabId);
		}
		setRefreshSignal((s) => s + 1);
	};

	return (
		<SidebarContext.Provider value={contextValue}>
			<div className="flex flex-col h-full">
				<SidebarHeader />

				<div className="flex border-b border-th-border">
					{TABS.map(({ id, label, Icon }) => (
						<button
							key={id}
							type="button"
							onClick={() => handleTabClick(id)}
							className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-sm transition-colors ${
								activeTab === id
									? "border-b-2 border-th-accent text-th-accent"
									: "text-th-text-muted hover:text-th-text-primary"
							}`}
						>
							<Icon className="size-4" />
							{label}
						</button>
					))}
				</div>

				<div className="flex-1 overflow-y-auto">
					<SessionsTab />
					<NotesTab />
				</div>
			</div>
		</SidebarContext.Provider>
	);
}
