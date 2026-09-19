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

		expect(screen.getByText(/Waiting for your answer\./)).toBeInTheDocument();
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
			screen.getByText(/Waiting for your permission\./),
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

	// A disabled Send with no reason on screen is a silent failure. The strip is
	// the only place that reason can go, so the sentence is part of the refusal,
	// not decoration.
	it.each<[string, TurnBlocker]>([
		["question", question],
		["permission", permission],
	])("says why sending is refused during a %s", (_kind, blocker) => {
		render(
			<BlockerStrip
				turn={turn("blocked", [blocker])}
				onJumpToRequest={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(/Answer above or Stop before sending\./),
		).toBeInTheDocument();
	});

	// The receipt for a message sent into a running turn. Without it the reply
	// above simply keeps growing and nothing appears under the message, so a send
	// that landed and a send that vanished look identical.
	describe("a message sent into the running turn", () => {
		it("is acknowledged while the turn runs on", () => {
			render(
				<BlockerStrip
					turn={turn("running")}
					onJumpToRequest={vi.fn()}
					sendPending
				/>,
			);

			expect(
				screen.getByText("Sent into the reply the agent is working on."),
			).toBeInTheDocument();
		});

		// Sending *is* allowed during a background wait, so this is the one state
		// where the receipt has to outrank a blocker — otherwise a message lands
		// there with no acknowledgement at all.
		it("outranks a background wait", () => {
			render(
				<BlockerStrip
					turn={turn("blocked", [background])}
					onJumpToRequest={vi.fn()}
					sendPending
				/>,
			);

			expect(
				screen.getByText("Sent into the reply the agent is working on."),
			).toBeInTheDocument();
			expect(screen.queryByText(/nothing to answer/)).not.toBeInTheDocument();
		});

		// A prompt is what the session is stuck on and what sending is refused
		// for; the receipt can wait. Reachable because a request can be raised
		// after the message went in.
		it.each<[string, TurnBlocker]>([
			["question", question],
			["permission", permission],
		])("yields to a %s", (_kind, blocker) => {
			render(
				<BlockerStrip
					turn={turn("blocked", [blocker])}
					onJumpToRequest={vi.fn()}
					sendPending
				/>,
			);

			expect(
				screen.queryByText("Sent into the reply the agent is working on."),
			).not.toBeInTheDocument();
			expect(
				screen.getByText(/Answer above or Stop before sending\./),
			).toBeInTheDocument();
		});
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
