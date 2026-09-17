import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionTurn, TurnBlocker } from "../../types/message";
import BlockerStrip from "./BlockerStrip";

function turn(
	phase: SessionTurn["phase"],
	blockers?: TurnBlocker[],
): SessionTurn {
	return {
		phase,
		open: phase !== "idle",
		since: "2026-01-02T14:02:00Z",
		blockers,
	};
}

const question: TurnBlocker = {
	kind: "question",
	request_id: "q1",
	raised_at: "2026-01-02T14:02:00Z",
};
const permission: TurnBlocker = {
	kind: "permission",
	request_id: "p1",
	raised_at: "2026-01-02T14:02:00Z",
};
const background: TurnBlocker = {
	kind: "background",
	raised_at: "2026-01-02T14:02:00Z",
};

describe("BlockerStrip", () => {
	it.each<[SessionTurn["phase"], TurnBlocker[] | undefined]>([
		["idle", undefined],
		["running", undefined],
	])("says nothing while the turn is %s", (phase, blockers) => {
		const { container } = render(
			<BlockerStrip turn={turn(phase, blockers)} onJumpToRequest={vi.fn()} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("jumps to the question holding the turn up", async () => {
		const user = userEvent.setup();
		const onJump = vi.fn();
		render(
			<BlockerStrip
				turn={turn("blocked", [question])}
				onJumpToRequest={onJump}
			/>,
		);

		expect(screen.getByText("Waiting for your answer.")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Jump to question" }));
		expect(onJump).toHaveBeenCalledWith("q1");
	});

	// Permission outranks question, and the strip names the one it jumps to — the
	// same precedence the activity derivation uses.
	it("speaks for the permission when both are live", async () => {
		const user = userEvent.setup();
		const onJump = vi.fn();
		render(
			<BlockerStrip
				turn={turn("blocked", [question, permission])}
				onJumpToRequest={onJump}
			/>,
		);

		expect(
			screen.getByText("Waiting for your permission."),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Jump to request" }));
		expect(onJump).toHaveBeenCalledWith("p1");
	});

	// The two things a user who has waited an hour needs told before they reach
	// for Stop.
	it("explains a background wait on request", async () => {
		const user = userEvent.setup();
		render(
			<BlockerStrip
				turn={turn("blocked", [background])}
				onJumpToRequest={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(/nothing to answer/, { exact: false }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Details" }));

		const detail = screen.getByText(/resumes on its own/, { exact: false });
		expect(detail).toHaveTextContent(
			"Stopping ends the turn and loses the tasks.",
		);
		// Stated as a time, never as a countdown to a lease the user cannot change.
		expect(detail.textContent).toMatch(/since \d{1,2}:\d{2}/);
	});

	// There is no per-task kill: the model gives the host no way to end one task
	// without ending the turn, so the strip must not offer one.
	it("offers nothing to press against the task itself", () => {
		render(
			<BlockerStrip
				turn={turn("blocked", [background])}
				onJumpToRequest={vi.fn()}
			/>,
		);
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
