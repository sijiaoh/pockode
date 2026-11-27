import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ContentPart } from "../../types/message";
import { PartBlocks } from "./ToolList";

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Lets the resize observers report and React commit what they did. */
async function settle() {
	for (let i = 0; i < 3; i++) await act(nextFrame);
}

const call = (id: string, name: string, input: unknown): ContentPart => ({
	type: "tool_call",
	id: `call-${id}`,
	tool: { id, name, input, status: "success" },
});

const parts: ContentPart[] = [
	call("a", "Edit", { file_path: "/w/web/src/components/Chat/ToolRow.tsx" }),
	call("b", "Edit", { file_path: "/w/web/src/lib/toolGroups.ts" }),
	call("c", "Bash", { command: "pnpm run test" }),
	call("d", "Read", { file_path: "/w/web/src/lib/toolSummary.ts" }),
	call("e", "Read", { file_path: "/w/web/src/components/Chat/ToolList.tsx" }),
	call("f", "Read", { file_path: "/w/web/src/lib/partTree.ts" }),
];

function List({ width }: { width: number }) {
	return (
		<div style={{ width }}>
			<PartBlocks
				items={parts.map((part) => ({ part }))}
				renderPart={({ part }) => (
					<span>{part.type === "tool_call" ? part.tool.id : ""}</span>
				)}
			/>
		</div>
	);
}

function summaryLine(): HTMLElement {
	const button = screen.getByRole("button", { name: /^done/ });
	const line = button.querySelector(".truncate");
	if (!(line instanceof HTMLElement)) throw new Error("no summary line");
	return line;
}

describe("ToolGroupSummary", () => {
	it("gives names up before counts to fit a phone's width, and takes them back when there is room", async () => {
		const { rerender } = render(<List width={1200} />);
		await settle();
		expect(summaryLine()).toHaveTextContent(
			"Edited ToolRow.tsx, toolGroups.ts · Ran pnpm run test · Read toolSummary.ts, ToolList.tsx, partTree.ts",
		);

		rerender(<List width={420} />);
		await settle();
		const line = summaryLine();
		// Fits whole: what it gave up it gave up a name at a time, so no `+K`
		// was cut off the end.
		expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
		expect(line).toHaveTextContent(/^Edited ToolRow\.tsx/);
		expect(line).toHaveTextContent(/Read 3 files$/);

		rerender(<List width={1200} />);
		await settle();
		expect(summaryLine()).toHaveTextContent(/partTree\.ts$/);
	});
});
