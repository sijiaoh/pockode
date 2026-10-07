import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Folder, GitCompare, MessageSquare } from "lucide-react";
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

const threeTabs: TabConfig[] = [
	{ id: "sessions", label: "Sessions", icon: MessageSquare },
	{ id: "files", label: "Files", icon: Folder },
	{ id: "git", label: "Git", icon: GitCompare },
];

function renderThreeTabs() {
	render(
		<TabbedSidebar
			isOpen={true}
			onClose={() => {}}
			tabs={threeTabs}
			defaultTab="sessions"
			isExpanded={true}
		>
			<div />
		</TabbedSidebar>,
	);
}

function expectSelected(name: string) {
	const tab = screen.getByRole("tab", { name });
	expect(tab).toHaveAttribute("aria-selected", "true");
	expect(tab).toHaveAttribute("tabindex", "0");
	expect(tab).toHaveFocus();
	expect(screen.getByRole("tabpanel")).toHaveAccessibleName(name);
}

describe("TabbedSidebar", () => {
	it("exposes the bar as a tablist whose selected tab labels the panel", () => {
		renderThreeTabs();
		expect(screen.getAllByRole("tab")).toHaveLength(3);
		expect(screen.getByRole("tablist")).toBeInTheDocument();

		const sessions = screen.getByRole("tab", { name: "Sessions" });
		expect(sessions).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
			"aria-selected",
			"false",
		);
		const panel = screen.getByRole("tabpanel", { name: "Sessions" });
		expect(sessions).toHaveAttribute("aria-controls", panel.id);

		fireEvent.click(screen.getByRole("tab", { name: "Files" }));
		expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(sessions).toHaveAttribute("aria-selected", "false");
		expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Files");
	});

	it("keeps only the selected tab in the tab order", () => {
		renderThreeTabs();
		expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
			"tabindex",
			"0",
		);
		expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
			"tabindex",
			"-1",
		);
		expect(screen.getByRole("tab", { name: "Git" })).toHaveAttribute(
			"tabindex",
			"-1",
		);
	});

	it("moves and selects with the arrow keys, wrapping at both ends", async () => {
		const user = userEvent.setup();
		renderThreeTabs();
		screen.getByRole("tab", { name: "Sessions" }).focus();

		await user.keyboard("{ArrowRight}");
		expectSelected("Files");

		await user.keyboard("{ArrowRight}");
		expectSelected("Git");

		await user.keyboard("{ArrowRight}");
		expectSelected("Sessions");

		await user.keyboard("{ArrowLeft}");
		expectSelected("Git");
	});

	it("jumps to the first and last tab with Home and End", async () => {
		const user = userEvent.setup();
		renderThreeTabs();
		screen.getByRole("tab", { name: "Sessions" }).focus();

		await user.keyboard("{End}");
		expectSelected("Git");

		await user.keyboard("{Home}");
		expectSelected("Sessions");
	});

	it("gives every tab the same bottom border so the selected icon does not sit higher", () => {
		renderThreeTabs();
		for (const tab of screen.getAllByRole("tab")) {
			expect(tab).toHaveClass("border-b-2");
		}
		expect(screen.getByRole("tab", { name: "Files" })).toHaveClass(
			"border-transparent",
		);
	});

	it("speaks the count after the tab label", () => {
		renderWithCount({ value: 5, label: "5 changed files" });
		expect(
			screen.getByRole("tab", { name: "Git, 5 changed files" }),
		).toBeInTheDocument();
	});

	it("speaks the plain tab label when there is no count", () => {
		renderWithCount(undefined);
		expect(screen.getByRole("tab", { name: "Git" })).toBeInTheDocument();
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
		fireEvent.click(screen.getByRole("tab", { name: "Git" }));
		expect(screen.getByText("active: git")).toBeInTheDocument();

		rerender(renderTabs([sessions]));
		expect(screen.getByText("active: sessions")).toBeInTheDocument();

		rerender(renderTabs([sessions, git]));
		expect(screen.getByText("active: sessions")).toBeInTheDocument();
	});

	it("refreshes when a collapsed column is expanded, not when it first mounts expanded", () => {
		function Signal() {
			return <p>signal: {useContext(SidebarContext)?.refreshSignal}</p>;
		}
		const renderColumn = (isOpen: boolean) => (
			<TabbedSidebar
				isOpen={isOpen}
				onClose={() => {}}
				tabs={threeTabs}
				defaultTab="sessions"
				isExpanded={true}
			>
				<Signal />
			</TabbedSidebar>
		);

		const { rerender } = render(renderColumn(true));
		expect(screen.getByText("signal: 0")).toBeInTheDocument();

		rerender(renderColumn(false));
		expect(screen.getByText("signal: 0")).toBeInTheDocument();

		rerender(renderColumn(true));
		expect(screen.getByText("signal: 1")).toBeInTheDocument();
	});
});
