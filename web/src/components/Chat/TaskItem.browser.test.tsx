import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TaskItem from "./TaskItem";

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const REPORT =
	"レビュー結果：チームの決定と議論がどこまで設計に反映されているかを確認しました";

function SettledRow({ width, result }: { width: number; result: string }) {
	return (
		<div style={{ width }}>
			<TaskItem
				run={{
					id: "t1",
					name: "Agent",
					input: { description: "Review: team decisions" },
					status: "success",
					result,
					subagent: { toolUses: 15, totalTokens: 45_600 },
				}}
				renderChild={() => null}
			/>
		</div>
	);
}

/** Whether `element` is drawn on the visible line of the box clipping it. */
const onTheLine = (element: Element) => {
	const box = element.closest(".overflow-hidden");
	if (!box) throw new Error("no clipping box");
	return (
		element.getBoundingClientRect().top < box.getBoundingClientRect().bottom
	);
};

// docs/tool-call-ui.md: on a settled row the tokens go first, whole; then the
// report truncates; the count never yields.
describe("a settled subagent row's figures", () => {
	it.each([
		360, 390,
	])("gives the report the line at %ipx, dropping the tokens", async (width) => {
		render(<SettledRow width={width} result={REPORT} />);
		await act(nextFrame);
		const count = screen.getByText("15 tool uses");
		const report = screen.getByText(REPORT);
		expect(onTheLine(count)).toBe(true);
		expect(count.scrollWidth).toBeLessThanOrEqual(count.clientWidth);
		expect(onTheLine(report)).toBe(true);
		expect(report.getBoundingClientRect().width).toBeGreaterThan(100);
		expect(onTheLine(screen.getByText("45.6K tokens"))).toBe(false);
	});

	it("keeps the tokens at the right end where there is room", async () => {
		render(<SettledRow width={900} result={REPORT} />);
		await act(nextFrame);
		const tokens = screen.getByText("45.6K tokens");
		expect(onTheLine(tokens)).toBe(true);
		expect(onTheLine(screen.getByText(REPORT))).toBe(true);
		const line = tokens.closest(".overflow-hidden");
		expect(
			Math.abs(
				(line?.getBoundingClientRect().right ?? 0) -
					tokens.getBoundingClientRect().right,
			),
		).toBeLessThan(1);
	});

	it("keeps the tokens on a phone when there is no report", async () => {
		render(<SettledRow width={360} result="" />);
		await act(nextFrame);
		expect(onTheLine(screen.getByText("15 tool uses"))).toBe(true);
		expect(onTheLine(screen.getByText("45.6K tokens"))).toBe(true);
	});
});
