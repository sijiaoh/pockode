import { render, screen } from "@testing-library/react";
import { GitCompare } from "lucide-react";
import { describe, expect, it } from "vitest";
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
});
