import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ContentPart } from "../../types/message";
import TaskItem from "./TaskItem";
import { PartBlocks } from "./ToolList";

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const step = (id: string, name: string, input: unknown): ContentPart => ({
	type: "tool_call",
	id: `call-${id}`,
	tool: {
		id,
		name,
		input,
		status: "running",
		seenAt: new Date(Date.now() - 64_000),
	},
});

// Built per render, so the counter reads the same figure however long the
// runner took to get here.
const subagent = (): ContentPart => ({
	type: "tool_call",
	id: "call-t1",
	tool: {
		id: "t1",
		name: "Agent",
		input: { description: "Find retry handling", subagent_type: "Explore" },
		status: "running",
		children: [
			step("a", "Read", {
				file_path:
					"/w/server/internal/relay/transport/websocket/reconnect/sender.go",
			}),
			step("b", "Bash", {
				command:
					"go test ./relay/... -run TestRetryAfterHonoursTheServersBackoffHeader -count=1",
			}),
		],
	},
});

function Transcript({ width }: { width: number }) {
	return (
		<div style={{ width }}>
			<PartBlocks
				items={[{ part: subagent() }]}
				renderPart={({ part }) =>
					part.type === "tool_call" && (
						<TaskItem run={part.tool} renderChild={() => null} />
					)
				}
			/>
		</div>
	);
}

/** Whether an element shows all of its text, uncut. */
const whole = (element: Element) => element.scrollWidth <= element.clientWidth;

describe("SubagentStepWindow", () => {
	// docs/tool-call-ui.md#the-step-window: the glyph, the title and the time
	// never yield; the detail truncates, losing directories first.
	it.each([
		320, 360,
	])("keeps each line to one line at %ipx, cutting only the detail", async (width) => {
		render(<Transcript width={width} />);
		await act(nextFrame);
		const row = screen.getByRole("button", { name: /Find retry handling/ });
		const window = row.querySelector("[data-step-window]");
		expect(window).not.toBeNull();
		const lines = Array.from(window?.children ?? []);
		expect(lines).toHaveLength(2);
		const lineHeight = Number.parseFloat(getComputedStyle(lines[0]).lineHeight);
		for (const line of lines) {
			expect(line.getBoundingClientRect().height).toBeLessThanOrEqual(
				lineHeight + 1,
			);
			const title = Array.from(line.children).find((el) =>
				/^(Read|Bash)$/.test(el.textContent ?? ""),
			);
			expect(title && whole(title)).toBe(true);
			expect(line).toHaveTextContent(/1m 4s$/);
		}
		// The file name survives where the directories do not.
		expect(lines[0]).toHaveTextContent("sender.go");
	});
});
