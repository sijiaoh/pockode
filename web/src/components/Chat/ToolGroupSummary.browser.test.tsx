import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

function List({
	width,
	shown = parts,
	hidden = false,
}: {
	width: number;
	shown?: ContentPart[];
	hidden?: boolean;
}) {
	return (
		<div style={{ width, display: hidden ? "none" : undefined }}>
			<PartBlocks
				items={shown.map((part) => ({ part }))}
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

/** The invisible copies a line measures its forms from, while it measures. */
const copies = () => document.querySelectorAll("[aria-hidden] > .w-max");

/** Counts layout reads made while `run` commits, before any frame. */
function readsDuring(run: () => void) {
	const read = vi.spyOn(Element.prototype, "getBoundingClientRect");
	try {
		act(run);
		return read.mock.calls.length;
	} finally {
		read.mockRestore();
	}
}

const another = call("g", "Read", { file_path: "/w/web/src/lib/retry.ts" });

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
		// Fits whole: what it gave up it gave up a name at a time, so no name
		// was cut off the end.
		expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
		// The front segment keeps a name longest, with its count once it has
		// given one up.
		expect(line).toHaveTextContent(/^Edited (2 files: )?ToolRow\.tsx/);
		expect(line).toHaveTextContent(/Read 3 files$/);

		rerender(<List width={1200} />);
		await settle();
		expect(summaryLine()).toHaveTextContent(/partTree\.ts$/);
	});

	it("does nothing when a render brings the same words at the same width", async () => {
		const { rerender } = render(<List width={420} />);
		await settle();
		const before = summaryLine().textContent;

		const reads = readsDuring(() =>
			rerender(<List width={420} shown={parts.map((part) => ({ ...part }))} />),
		);
		expect(reads).toBe(0);
		expect(copies()).toHaveLength(0);
		await settle();
		expect(copies()).toHaveLength(0);
		expect(summaryLine().textContent).toBe(before);
	});

	it("measures new words in the frame's layout, not in the commit that brought them", async () => {
		const { rerender } = render(<List width={420} />);
		await settle();

		const reads = readsDuring(() =>
			rerender(<List width={420} shown={[...parts, another]} />),
		);
		expect(reads).toBe(0);
		await settle();
		expect(copies()).toHaveLength(0);
		const line = summaryLine();
		expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
		expect(line).toHaveTextContent(/Read 4 files$/);
	});

	it("measures nothing out of sight, and fits words that changed there once shown", async () => {
		const { rerender } = render(<List width={1200} />);
		await settle();
		rerender(<List width={420} hidden />);
		await settle();
		rerender(<List width={420} hidden shown={[...parts, another]} />);
		await settle();
		expect(copies()).toHaveLength(0);

		rerender(<List width={420} shown={[...parts, another]} />);
		await settle();
		expect(copies()).toHaveLength(0);
		const line = summaryLine();
		expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
		expect(line).toHaveTextContent(/Read 4 files$/);
	});
});
