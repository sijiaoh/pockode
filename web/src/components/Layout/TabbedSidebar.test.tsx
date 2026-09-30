import { fireEvent, render, screen } from "@testing-library/react";
import { GitCompare, MessageSquare } from "lucide-react";
import { useContext } from "react";
import { describe, expect, it } from "vitest";
import { SidebarContext } from "./SidebarContext";
import TabbedSidebar, { type TabConfig } from "./TabbedSidebar";

function renderWithCount(
	countBadge: { value: number; label: string } | undefined,
) {
	const tabs: TabConfig[] = [
		{ id: "git", label: "Git", icon: GitCompare, countBadge },
	];
	render(
		<TabbedSidebar
			isOpen={true}
			onClose={() => {}}
			tabs={tabs}
			defaultTab="git"
			isExpanded={true}
		>
			<div />
		</TabbedSidebar>,
	);
}

describe("TabbedSidebar", () => {
	it("speaks the count after the tab label", () => {
		renderWithCount({ value: 5, label: "5 changed files" });
		expect(
			screen.getByRole("button", { name: "Git, 5 changed files" }),
		).toBeInTheDocument();
	});

	it("speaks the plain tab label when there is no count", () => {
		renderWithCount(undefined);
		expect(screen.getByRole("button", { name: "Git" })).toBeInTheDocument();
	});

	it("falls back to the default tab when the open one is taken away, and stays there when it returns", () => {
		const sessions: TabConfig = {
			id: "sessions",
			label: "Sessions",
			icon: MessageSquare,
		};
		const git: TabConfig = { id: "git", label: "Git", icon: GitCompare };
		function ActiveTab() {
			return <p>active: {useContext(SidebarContext)?.activeTab}</p>;
		}
		const renderTabs = (tabs: TabConfig[]) => (
			<TabbedSidebar
				isOpen={true}
				onClose={() => {}}
				tabs={tabs}
				defaultTab="sessions"
				isExpanded={true}
			>
				<ActiveTab />
			</TabbedSidebar>
		);

		const { rerender } = render(renderTabs([sessions, git]));
		fireEvent.click(screen.getByRole("button", { name: "Git" }));
		expect(screen.getByText("active: git")).toBeInTheDocument();

		rerender(renderTabs([sessions]));
		expect(screen.getByText("active: sessions")).toBeInTheDocument();

		rerender(renderTabs([sessions, git]));
		expect(screen.getByText("active: sessions")).toBeInTheDocument();
	});
});
