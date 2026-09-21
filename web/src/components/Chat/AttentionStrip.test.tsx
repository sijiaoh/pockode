import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SessionTurn, TurnBlocker } from "../../types/message";
import AttentionStrip from "./AttentionStrip";

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

const permission: TurnBlocker = {
	kind: "permission",
	request_id: "p1",
	raised_at: "2026-01-02T14:02:00Z",
};
const background: TurnBlocker = {
	kind: "background",
	raised_at: "2026-01-02T14:02:00Z",
};

function unanswered(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		request_id: `u${i}`,
		header: "Database",
		question: "Which database should I use?",
		options: [],
		multi_select: false,
		asked_at: "2026-01-02T14:02:00Z",
	}));
}

describe("AttentionStrip", () => {
	it.each<[SessionTurn["phase"], TurnBlocker[] | undefined]>([
		["idle", undefined],
		["running", undefined],
	])("says nothing while the turn is %s", (phase, blockers) => {
		const { container } = render(
			<AttentionStrip turn={turn(phase, blockers)} onJumpToRequest={vi.fn()} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("jumps to the permission request holding the turn up", async () => {
		const user = userEvent.setup();
		const onJump = vi.fn();
		render(
			<AttentionStrip
				turn={turn("blocked", [permission])}
				onJumpToRequest={onJump}
			/>,
		);

		expect(
			screen.getByText(/Waiting for your permission\./),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Jump to request" }));
		expect(onJump).toHaveBeenCalledWith("p1");
	});

	// Permission outranks background — the same precedence the activity derivation
	// uses, and for the same reason: one of them has something to press.
	it("speaks for the permission when a background wait is live too", async () => {
		const user = userEvent.setup();
		const onJump = vi.fn();
		render(
			<AttentionStrip
				turn={turn("blocked", [background, permission])}
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
			<AttentionStrip
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

	describe("the unanswered questions row", () => {
		it("counts them and offers the one way to answer", async () => {
			const user = userEvent.setup();
			const onAnswer = vi.fn();
			render(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: unanswered(2) }}
					onJumpToRequest={vi.fn()}
					onAnswer={onAnswer}
				/>,
			);

			expect(
				screen.getByText("2 questions are waiting for your answer."),
			).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Answer" }));
			expect(onAnswer).toHaveBeenCalled();
		});

		// Sending is not refused while a posted question is open: the agent may
		// be running, and a typed message is an ordinary message. A sentence
		// about sending here would be inventing a restriction to explain.
		it("says nothing about sending", () => {
			render(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: unanswered(1) }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
				/>,
			);
			expect(
				screen.getByText("1 question is waiting for your answer."),
			).toBeInTheDocument();
			expect(screen.queryByText(/before sending/)).not.toBeInTheDocument();
		});

		// No "nothing to answer", no empty frame.
		it("does not exist at zero", () => {
			const { container } = render(
				<AttentionStrip
					turn={{ ...turn("idle"), unanswered: [] }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
				/>,
			);
			expect(container).toBeEmptyDOMElement();
		});

		// Permission is the only row the composer is disabled under, and the only
		// state in which the server refuses the answer message itself.
		it("yields to a permission request", () => {
			render(
				<AttentionStrip
					turn={{
						...turn("blocked", [permission]),
						unanswered: unanswered(1),
					}}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
				/>,
			);
			expect(
				screen.getByText(/Waiting for your permission\./),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Answer" }),
			).not.toBeInTheDocument();
		});

		// It is the one row with something to *do* that is not already on screen.
		it("outranks the send receipt", () => {
			render(
				<AttentionStrip
					turn={{ ...turn("running"), unanswered: unanswered(1) }}
					onJumpToRequest={vi.fn()}
					onAnswer={vi.fn()}
					sendPending
				/>,
			);
			expect(
				screen.getByRole("button", { name: "Answer" }),
			).toBeInTheDocument();
		});
	});

	// A disabled Send with no reason on screen is a silent failure. The strip is
	// the only place that reason can go, so the sentence is part of the refusal,
	// not decoration.
	it("says why sending is refused during a permission request", () => {
		render(
			<AttentionStrip
				turn={turn("blocked", [permission])}
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
				<AttentionStrip
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
				<AttentionStrip
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
		it("yields to a permission request", () => {
			render(
				<AttentionStrip
					turn={turn("blocked", [permission])}
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
			<AttentionStrip
				turn={turn("blocked", [background])}
				onJumpToRequest={vi.fn()}
			/>,
		);
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
