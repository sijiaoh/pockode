import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuestionDraftStore } from "../../lib/questionDraftStore";
import type { PendingQuestion } from "../../types/message";
import AnswerSheet from "./AnswerSheet";

const database: PendingQuestion = {
	request_id: "r1",
	header: "Database",
	question: "Which database should I use?",
	options: [
		{ label: "Postgres", description: "Managed" },
		{ label: "SQLite", description: "One file" },
	],
	multi_select: false,
	asked_at: "2026-01-02T14:02:00Z",
};

const region: PendingQuestion = {
	request_id: "r2",
	header: "Region",
	question: "Which region?",
	options: [],
	multi_select: false,
	asked_at: "2026-01-02T14:03:00Z",
};

function renderSheet(
	unanswered: PendingQuestion[],
	onSend = vi.fn().mockResolvedValue(undefined),
) {
	const onClose = vi.fn();
	const result = render(
		<AnswerSheet
			sessionId="s1"
			unanswered={unanswered}
			onSend={onSend}
			onClose={onClose}
		/>,
	);
	return { ...result, onSend, onClose };
}

beforeEach(() => {
	useQuestionDraftStore.setState({ drafts: {} });
});

describe("AnswerSheet", () => {
	it("titles itself with the live count and counts what is ready", () => {
		renderSheet([database, region]);
		expect(screen.getByText("2 questions")).toBeInTheDocument();
		expect(screen.getByText("0 of 2 ready")).toBeInTheDocument();
	});

	// A question with no options is the shape a free-text request takes, and it
	// needs no second surface and no second copy.
	it("draws a question with no options as free text", () => {
		renderSheet([region]);
		expect(screen.getByPlaceholderText("Your answer")).toBeInTheDocument();
	});

	// **Other** is not the same lever as "Won't answer" and neither replaces the
	// other: Other is "my answer is something else", declining is "I am not
	// answering this". Recording the first as the second would tell the agent the
	// user refused and throw away the most useful sentence on the screen.
	it("offers an Other row beside a question's options", () => {
		renderSheet([database]);
		expect(screen.getByRole("radio", { name: /Other/ })).toBeInTheDocument();
		expect(screen.getAllByRole("radio")).toHaveLength(3);
	});

	// The user's own words go in `text`, never among the labels. The label check
	// exists so the agent is not told it was handed back a choice it never gave;
	// it is not there to stop the user saying something else.
	it("sends what the user typed apart from the labels", async () => {
		const user = userEvent.setup();
		const { onSend } = renderSheet([database]);

		await user.click(screen.getByRole("radio", { name: /Other/ }));
		await user.type(
			screen.getByPlaceholderText("Enter your answer..."),
			"MySQL",
		);
		await user.click(screen.getByRole("button", { name: "Send" }));

		const [content, answering] = onSend.mock.calls[0];
		expect(answering).toMatchObject([
			{ request_id: "r1", answers: [], text: "MySQL" },
		]);
		// The prose is the only half the CLI reads, so it has to say in words what
		// the record says structurally.
		expect(content).toContain("A: MySQL");
	});

	// Ticking Other is not yet an answer, and Send must not offer to deliver one:
	// the server refuses "answered with nothing", and a control whose use is
	// refused is the dead end this whole design exists to remove.
	it("does not count a ticked but empty Other as ready", async () => {
		const user = userEvent.setup();
		renderSheet([database]);

		await user.click(screen.getByRole("radio", { name: /Other/ }));

		expect(screen.getByText("0 of 1 ready")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("sends nothing but the labels the question offered when Other is unused", async () => {
		const user = userEvent.setup();
		const { onSend } = renderSheet([
			{ ...database, multi_select: true, request_id: "r1" },
		]);

		await user.click(screen.getByRole("checkbox", { name: /Postgres/ }));
		await user.click(screen.getByRole("checkbox", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend.mock.calls[0][1]).toMatchObject([
			{ request_id: "r1", answers: ["Postgres", "SQLite"] },
		]);
		expect(onSend.mock.calls[0][1][0].text).toBeUndefined();
	});

	// Radios are exclusive and Other is one of them. The text is kept in the
	// draft so the user can change their mind back without retyping, but sending
	// it would answer with something they have taken back.
	it("does not send Other text the user has since unpicked", async () => {
		const user = userEvent.setup();
		const { onSend } = renderSheet([database]);

		await user.click(screen.getByRole("radio", { name: /Other/ }));
		await user.type(
			screen.getByPlaceholderText("Enter your answer..."),
			"MySQL",
		);
		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend.mock.calls[0][1]).toMatchObject([
			{ request_id: "r1", answers: ["SQLite"] },
		]);
		expect(onSend.mock.calls[0][1][0].text).toBeUndefined();
	});

	it("sends one message for every block that is ready", async () => {
		const user = userEvent.setup();
		const { onSend } = renderSheet([database, region]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend).toHaveBeenCalledTimes(1);
		const [content, answering] = onSend.mock.calls[0];
		expect(content).toContain("Q: Which database should I use?\nA: SQLite");
		expect(answering).toMatchObject([
			{
				request_id: "r1",
				header: "Database",
				question: "Which database should I use?",
				answers: ["SQLite"],
			},
		]);
	});

	// One question the user cannot decide must not hold up the two they can.
	it("leaves what was not submitted in the list", async () => {
		const user = userEvent.setup();
		const { onClose } = renderSheet([database, region]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onClose).not.toHaveBeenCalled();
		expect(await screen.findByText("1 answer sent.")).toBeInTheDocument();
	});

	it("clears a draft only once its own submit lands", async () => {
		const user = userEvent.setup();
		renderSheet([database]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		expect(useQuestionDraftStore.getState().drafts.s1?.r1.labels).toEqual([
			"SQLite",
		]);

		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(useQuestionDraftStore.getState().drafts.s1?.r1).toBeUndefined();
	});

	it("keeps a draft the server refused, and says which block it was", async () => {
		const user = userEvent.setup();
		const onSend = vi
			.fn()
			.mockRejectedValue(
				new Error(
					"that question is not waiting for an answer: r1 (answered by the user at 14:05)",
				),
			);
		renderSheet([database], onSend);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(
			await screen.findByText("Already answered elsewhere."),
		).toBeInTheDocument();
		expect(useQuestionDraftStore.getState().drafts.s1?.r1.labels).toEqual([
			"SQLite",
		]);
	});

	// The CLI holding a permission request open reads nothing else, so the
	// answer message cannot be delivered at all. What the user needs is where to
	// go, which is the row above the composer.
	it("says where to go when a permission request is in the way", async () => {
		const user = userEvent.setup();
		const onSend = vi
			.fn()
			.mockRejectedValue(
				new Error(
					"this turn is waiting for an answer to the request on screen: answer it, or stop the turn, then send",
				),
			);
		renderSheet([database], onSend);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(
			await screen.findByText(
				"The agent is waiting for a permission decision. Answer that first.",
			),
		).toBeInTheDocument();
		// Nothing was resolved, so nothing goes grey and Send stays live.
		expect(
			screen.queryByText("Already answered elsewhere."),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
	});

	// Declining is the user's lever for a question the agent forgot to withdraw,
	// and because it travels as a message it wakes the agent up.
	it("sends a decline with its note", async () => {
		const user = userEvent.setup();
		const { onSend } = renderSheet([region]);

		await user.click(screen.getByRole("checkbox", { name: /Won't answer/ }));
		await user.type(
			screen.getByPlaceholderText("Add a note (optional)"),
			"ask ops",
		);
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend.mock.calls[0][1]).toMatchObject([
			{ request_id: "r2", declined: true, note: "ask ops" },
		]);
	});

	it("does not clear what was picked when the user ticks Won't answer", async () => {
		const user = userEvent.setup();
		renderSheet([database]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("checkbox", { name: /Won't answer/ }));

		expect(useQuestionDraftStore.getState().drafts.s1?.r1.labels).toEqual([
			"SQLite",
		]);
	});

	// A sheet that vanished under a finger would make its own disappearance the
	// notification that somebody else answered.
	it("stays open and offers a way out when the list empties from elsewhere", () => {
		const { rerender, onClose } = renderSheet([database]);
		rerender(
			<AnswerSheet
				sessionId="s1"
				unanswered={[]}
				onSend={vi.fn()}
				onClose={onClose}
			/>,
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText("Nothing left to answer.")).toBeInTheDocument();
		// Two buttons say Close here — the sheet's own × and the footer's — and
		// both do the same thing. The footer's is the one that replaced Send.
		expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
		expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
	});

	it("closes itself once a submit leaves nothing behind", async () => {
		const user = userEvent.setup();
		const { rerender, onClose, onSend } = renderSheet([database]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(onSend).toHaveBeenCalled();

		rerender(
			<AnswerSheet
				sessionId="s1"
				unanswered={[]}
				onSend={onSend}
				onClose={onClose}
			/>,
		);
		expect(onClose).toHaveBeenCalled();
	});

	// A block that held nothing is not a loss, so nothing is announced.
	it("drops a block that leaves holding no draft", () => {
		const { rerender, onClose } = renderSheet([database, region]);
		rerender(
			<AnswerSheet
				sessionId="s1"
				unanswered={[region]}
				onSend={vi.fn()}
				onClose={onClose}
			/>,
		);
		expect(
			screen.queryByText("Which database should I use?"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Already answered elsewhere."),
		).not.toBeInTheDocument();
	});

	it("keeps a block that leaves holding a draft, until the user dismisses it", async () => {
		const user = userEvent.setup();
		const { rerender, onClose } = renderSheet([database, region]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		rerender(
			<AnswerSheet
				sessionId="s1"
				unanswered={[region]}
				onSend={vi.fn()}
				onClose={onClose}
			/>,
		);

		const stale = await screen.findByText("Already answered elsewhere.");
		expect(
			screen.getByText("Which database should I use?"),
		).toBeInTheDocument();
		// It does not count towards what can be sent.
		expect(screen.getByText("0 of 1 ready")).toBeInTheDocument();

		const block = stale.closest("[data-answer-block]");
		expect(block).not.toBeNull();
		await user.click(
			within(block as HTMLElement).getByRole("button", {
				name: "Dismiss this question",
			}),
		);
		expect(
			screen.queryByText("Which database should I use?"),
		).not.toBeInTheDocument();
		expect(useQuestionDraftStore.getState().drafts.s1?.r1).toBeUndefined();
	});
});
