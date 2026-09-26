import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { QuestionRecord } from "../../types/message";
import QuestionRecordItem from "./QuestionRecordItem";

const record: QuestionRecord = {
	requestId: "r1",
	question: {
		question: "Which database should I use?",
		header: "Database",
		options: [
			{ label: "Postgres", description: "Managed" },
			{ label: "SQLite", description: "One file" },
		],
		multiSelect: false,
	},
	askedAt: "2026-01-02T14:02:00Z",
};

describe("QuestionRecordItem", () => {
	// An open question is announced by the strip, which is on screen. A card
	// that opened itself would scroll the transcript under the reader to show
	// them something they cannot act on there.
	it("stays collapsed even while pending", () => {
		render(
			<QuestionRecordItem
				record={record}
				status="pending"
				onAnswer={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: /Database/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(
			screen.queryByRole("button", { name: "Answer this" }),
		).not.toBeInTheDocument();
	});

	// The reader never saw this question — another agent answered it — so the
	// card has to say so. An answered card with no resolver on it is the user's
	// own, which the chip already covers.
	it("says when an agent answered rather than the reader", async () => {
		const user = userEvent.setup();
		render(
			<QuestionRecordItem
				record={record}
				status="answered"
				answer={{
					request_id: "r1",
					answers: ["Postgres"],
					answered_at: "2026-01-02T14:05:00Z",
					resolved_by: { kind: "agent", work_id: "w1", title: "Ship the API" },
				}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Database/ }));
		expect(
			screen.getByText(
				'Answered by the agent working on "Ship the API", not by you.',
			),
		).toBeInTheDocument();
	});

	// Both shapes of the user's own answer: the one written now, and the one
	// every record written before an agent could answer at all carries.
	it.each([
		["stated outright", { kind: "user" as const }],
		["absent, as in older history", undefined],
	])("says nothing extra about an answer the user gave (%s)", async (_, by) => {
		const user = userEvent.setup();
		render(
			<QuestionRecordItem
				record={record}
				status="answered"
				answer={{
					request_id: "r1",
					answers: ["Postgres"],
					answered_at: "2026-01-02T14:05:00Z",
					...(by ? { resolved_by: by } : {}),
				}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Database/ }));
		expect(screen.queryByText(/not by you/)).not.toBeInTheDocument();
	});

	it("states its status on the header row in every state", () => {
		for (const [status, label] of [
			["pending", "Pending"],
			["answered", "Answered"],
			["declined", "Declined"],
			["cancelled", "Cancelled"],
		] as const) {
			const { unmount } = render(
				<QuestionRecordItem record={record} status={status} />,
			);
			expect(screen.getByText(label)).toBeInTheDocument();
			unmount();
		}
	});

	// A card that states `Pending` and offers nothing is a dead end. It holds no
	// state of its own — it calls the same opener the strip does.
	it("offers the panel from a pending body, and nothing else", async () => {
		const user = userEvent.setup();
		const onAnswer = vi.fn();
		render(
			<QuestionRecordItem
				record={record}
				status="pending"
				onAnswer={onAnswer}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /Database/ }));
		await user.click(screen.getByRole("button", { name: "Answer this" }));
		expect(onAnswer).toHaveBeenCalledWith("r1");
		// The form is a record, never a way in.
		expect(screen.getByRole("radio", { name: /SQLite/ })).toBeDisabled();
	});

	it("shows an answered card as the form that was filled in", async () => {
		const user = userEvent.setup();
		render(
			<QuestionRecordItem
				record={record}
				status="answered"
				answer={{
					request_id: "r1",
					answers: ["SQLite"],
					answered_at: "2026-01-02T14:05:00Z",
				}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Database/ }));
		expect(screen.getByRole("radio", { name: /SQLite/ })).toBeChecked();
	});

	// The two are told apart by a sentence, not by a colour: both mean "no
	// answer was given" and differ only in who decided.
	it("tells declined and cancelled apart in words", async () => {
		const user = userEvent.setup();
		const { unmount } = render(
			<QuestionRecordItem
				record={record}
				status="declined"
				answer={{
					request_id: "r1",
					declined: true,
					note: "ask ops",
					answered_at: "2026-01-02T14:05:00Z",
				}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Database/ }));
		expect(screen.getByText(/You declined to answer this/)).toBeInTheDocument();
		unmount();

		render(<QuestionRecordItem record={record} status="cancelled" />);
		await user.click(screen.getByRole("button", { name: /Database/ }));
		expect(
			screen.getByText(/The agent withdrew this question/),
		).toBeInTheDocument();
	});

	// Pockode withdraws a question on the agent's behalf in two cases, and each
	// says which. Without them, a question the engine took back reads exactly like
	// one the agent decided it no longer needed — and only one of those is
	// something the user could have acted on sooner.
	it("says what took a question back, when the server said", async () => {
		const user = userEvent.setup();
		for (const [reason, sentence] of [
			["work_closed", "The work it belonged to was closed."],
			["step_done", "The step it was asked during finished."],
		] as const) {
			const { unmount } = render(
				<QuestionRecordItem
					record={record}
					status="cancelled"
					reason={reason}
				/>,
			);
			await user.click(screen.getByRole("button", { name: /Database/ }));
			expect(screen.getByText(new RegExp(sentence))).toBeInTheDocument();
			unmount();
		}
	});

	// The plain case: the agent called question_cancel itself. There is nothing to
	// add, and inventing a cause would be worse than the sentence already there.
	it("adds nothing when the agent withdrew it itself", async () => {
		const user = userEvent.setup();
		render(<QuestionRecordItem record={record} status="cancelled" />);
		await user.click(screen.getByRole("button", { name: /Database/ }));
		expect(
			screen.getByText("The agent withdrew this question."),
		).toBeInTheDocument();
	});

	// The card the CLI's own blocking question left behind. Nothing can answer it,
	// so it says so and offers no way in — that sentence is the whole of what
	// replaced the `expired` status and its table of reasons.
	it("says a legacy pending question can no longer be answered", async () => {
		const user = userEvent.setup();
		render(
			<QuestionRecordItem
				record={record}
				status="pending"
				legacy
				onAnswer={vi.fn()}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Database/ }));

		expect(screen.getByText(/can no longer be answered/)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Answer this" }),
		).not.toBeInTheDocument();
	});

	// An old answer still reads back as the form that was filled in, which is the
	// whole reason these records go through this card at all.
	it("fills a legacy answered card in from both halves of the answer", async () => {
		const user = userEvent.setup();
		render(
			<QuestionRecordItem
				record={record}
				status="answered"
				legacy
				answer={{
					request_id: "r1",
					answers: ["SQLite"],
					text: "and pin the version",
					answered_at: "",
				}}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Database/ }));

		expect(screen.getByRole("radio", { name: /One file/ })).toBeChecked();
		expect(screen.getByText("and pin the version")).toBeInTheDocument();
	});

	it("offers nothing when the host cannot answer", async () => {
		const user = userEvent.setup();
		render(<QuestionRecordItem record={record} status="pending" />);
		await user.click(screen.getByRole("button", { name: /Database/ }));
		expect(
			screen.queryByRole("button", { name: "Answer this" }),
		).not.toBeInTheDocument();
	});

	// The card is read-only, but only its choices are: a code block the agent put
	// in the question is still there to be copied.
	it("keeps the choices read-only without disabling the question's code block", async () => {
		const user = userEvent.setup();
		render(
			<QuestionRecordItem
				record={{
					...record,
					question: {
						...record.question,
						question: "Run this?\n\n```sh\nmake migrate\n```",
					},
				}}
				status="pending"
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Database/ }));

		expect(screen.getByRole("radio", { name: /Managed/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Copy code" })).toBeEnabled();
	});
});
