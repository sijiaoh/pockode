import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import StepList from "./StepList";

// The real MarkdownContent, deliberately: the claim under test is that a step's
// markdown reaches the DOM as markup, which a stubbed renderer cannot make.
//
// Both steps below are the shapes the default roles actually ship
// (`server/agentrole/store.go`), not invented ones — they are the two ways a
// step's own line breaks used to be lost.
describe("StepList", () => {
	it("renders a step's markdown rather than its source", () => {
		render(
			<StepList
				steps={["推进任务\n\n- 通过 MCP 启动任务\n- 根据汇报调整任务"]}
				currentStep={0}
				workStatus="active"
			/>,
		);

		expect(screen.getByText("推进任务").tagName).toBe("P");

		const bullet = screen.getByText("通过 MCP 启动任务");
		expect(bullet.tagName).toBe("LI");
		expect(bullet.closest("ul")).not.toBeNull();
	});

	// A single newline, which HTML collapses to a space: as plain text this step
	// read as one run-on line, and nothing said so.
	it("keeps a line break a step wrote without a blank line around it", () => {
		const { container } = render(
			<StepList
				steps={["创建任务\n始终在最后追加文档维护任务"]}
				currentStep={0}
				workStatus="active"
			/>,
		);

		expect(container.querySelectorAll("br")).toHaveLength(1);
	});

	// A class assertion, because jsdom lays nothing out. Why the wrapper needs
	// its own `min-w-0` despite the prose root's is on the wrapper in `StepList`.
	it("keeps a step's markdown from widening the list", () => {
		render(
			<StepList steps={["推进任务"]} currentStep={0} workStatus="active" />,
		);

		const row = screen.getByText("推进任务").closest("li");
		expect(row?.classList).toContain("flex");

		const wrapper = screen
			.getByText("推进任务")
			.closest("div.prose")?.parentElement;
		expect(wrapper?.parentElement).toBe(row);
		expect(wrapper?.classList).toContain("min-w-0");
	});
});
