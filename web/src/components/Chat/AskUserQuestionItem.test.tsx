import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AskUserQuestionRequest } from "../../types/message";
import AskUserQuestionItem from "./AskUserQuestionItem";

const request: AskUserQuestionRequest = {
	requestId: "req-1",
	toolUseId: "tool-1",
	questions: [
		{
			question: "Which framework?",
			header: "Framework",
			options: [
				{ label: "React", description: "The web one" },
				{ label: "Vue", description: "The other one" },
			],
			multiSelect: false,
		},
	],
};

const multiRequest: AskUserQuestionRequest = {
	...request,
	questions: [{ ...request.questions[0], multiSelect: true }],
};

const twoQuestionRequest: AskUserQuestionRequest = {
	...request,
	questions: [
		request.questions[0],
		{
			question: "Which bundler?",
			header: "Bundler",
			options: [
				{ label: "Vite", description: "The fast one" },
				{ label: "Webpack", description: "The established one" },
			],
			multiSelect: false,
		},
	],
};

// delay: null keeps interactions off the macrotask queue; with the default
// pacing these tests can exceed the 5s timeout when the suite saturates the CPU.
const setupUser = () => userEvent.setup({ delay: null });

const expand = async (user: ReturnType<typeof userEvent.setup>) => {
	await user.click(screen.getByRole("button", { name: /Framework/ }));
};

describe("AskUserQuestionItem", () => {
	it("shows the original form with the chosen option selected after answering", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={request}
				status="answered"
				savedAnswers={{ "Which framework?": "Vue" }}
			/>,
		);

		await expand(user);

		expect(screen.getByText("Which framework?")).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /The other one/ })).toBeChecked();
		expect(
			screen.getByRole("radio", { name: /The web one/ }),
		).not.toBeChecked();
	});

	it("summarizes the answer on the collapsed card and restores every question", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={twoQuestionRequest}
				status="answered"
				savedAnswers={{ "Which framework?": "Vue", "Which bundler?": "Vite" }}
			/>,
		);

		const card = screen.getByRole("button", { name: /Framework/ });
		expect(card).toHaveTextContent("Vue · +1");

		await user.click(card);

		expect(screen.getByRole("radio", { name: /The other one/ })).toBeChecked();
		expect(screen.getByRole("radio", { name: /The fast one/ })).toBeChecked();
		expect(
			screen.getByRole("radio", { name: /The established one/ }),
		).not.toBeChecked();
	});

	it("keeps the answered form read-only", async () => {
		const user = setupUser();
		const onRespond = vi.fn();
		render(
			<AskUserQuestionItem
				request={request}
				status="answered"
				savedAnswers={{ "Which framework?": "Vue" }}
				onRespond={onRespond}
			/>,
		);

		await expand(user);

		const unchosen = screen.getByRole("radio", { name: /The web one/ });
		expect(unchosen).toBeDisabled();
		await user.click(unchosen);
		expect(unchosen).not.toBeChecked();
		expect(
			screen.queryByRole("button", { name: "Submit" }),
		).not.toBeInTheDocument();
	});

	it("shows a long free-text answer as text instead of a clipped input", async () => {
		const user = setupUser();
		const answer = "Svelte, or maybe Solid, depending on what the team knows";
		render(
			<AskUserQuestionItem
				request={request}
				status="answered"
				savedAnswers={{ "Which framework?": `Other: ${answer}` }}
			/>,
		);

		await expand(user);

		expect(screen.getByRole("radio", { name: /Other/ })).toBeChecked();
		const form = screen.getByRole("group", { name: "Question form" });
		expect(within(form).getByText(answer)).toBeInTheDocument();
		expect(within(form).queryByRole("textbox")).toBeNull();
	});

	it("collapses once answered and can be reopened", async () => {
		const user = setupUser();
		const { rerender } = render(
			<AskUserQuestionItem
				request={request}
				status="pending"
				onRespond={vi.fn()}
			/>,
		);

		expect(screen.getByRole("radio", { name: /The web one/ })).toBeVisible();

		rerender(
			<AskUserQuestionItem
				request={request}
				status="answered"
				savedAnswers={{ "Which framework?": "React" }}
				onRespond={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("radio", { name: /The web one/ })).toBeNull();

		await expand(user);
		expect(screen.getByRole("radio", { name: /The web one/ })).toBeChecked();
	});

	it("explains a cancelled question instead of showing an empty answer", async () => {
		const user = setupUser();
		render(<AskUserQuestionItem request={request} status="cancelled" />);

		await expand(user);

		expect(screen.getByText(/You cancelled this question/)).toBeInTheDocument();
		expect(screen.getByText("Which framework?")).toBeInTheDocument();
		for (const radio of screen.getAllByRole("radio")) {
			expect(radio).not.toBeChecked();
		}
	});

	it("warns when a saved answer cannot be matched to its question", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={{
					...request,
					questions: [
						request.questions[0],
						{ ...request.questions[0], question: "Which bundler?" },
					],
				}}
				status="answered"
				savedAnswers={{ "Which framework?": "Vue" }}
			/>,
		);

		await expand(user);

		expect(
			screen.getByText(/answer for this question could not be restored/),
		).toBeInTheDocument();
	});

	it("disables the form when there is no way to respond", () => {
		render(<AskUserQuestionItem request={request} status="pending" />);

		expect(screen.getByRole("radio", { name: /The web one/ })).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: "Submit" }),
		).not.toBeInTheDocument();
	});

	it("keeps the typed Other text when another option is tried", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={request}
				status="pending"
				onRespond={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("radio", { name: /Other/ }));
		await user.type(screen.getByRole("textbox"), "Svelte");
		await user.click(screen.getByRole("radio", { name: /The web one/ }));
		await user.click(screen.getByRole("radio", { name: /Other/ }));

		expect(screen.getByRole("textbox")).toHaveValue("Svelte");
	});

	it("submits selected options together with the free-text answer", async () => {
		const user = setupUser();
		const onRespond = vi.fn();
		render(
			<AskUserQuestionItem
				request={multiRequest}
				status="pending"
				onRespond={onRespond}
			/>,
		);

		await user.click(screen.getByRole("checkbox", { name: /The web one/ }));
		await user.click(screen.getByRole("checkbox", { name: /Other/ }));
		await user.type(screen.getByRole("textbox"), "Svelte, please");
		await user.click(screen.getByRole("button", { name: "Submit" }));

		expect(onRespond).toHaveBeenCalledWith(multiRequest, {
			"Which framework?": "React, Other: Svelte, please",
		});
	});
});

// An expired question is still worth answering: the request is gone — only the
// process that raised it could have taken the answer — but what the user was
// going to say is not, and it reaches the agent as an ordinary message instead
// (docs/lifecycle-ui.md §5.1).
describe("an expired question", () => {
	const openCard = async (user: ReturnType<typeof setupUser>) => {
		await user.click(screen.getByRole("button", { name: /Framework/ }));
	};

	it("stays answerable, and says what pressing the button will do", async () => {
		const user = setupUser();
		const onSendAsMessage = vi.fn();
		render(
			<AskUserQuestionItem
				request={request}
				status="expired"
				onSendAsMessage={onSendAsMessage}
			/>,
		);

		await openCard(user);
		await user.click(screen.getByRole("radio", { name: /The web one/ }));
		await user.click(screen.getByRole("button", { name: "Send as message" }));

		// The question travels with the answer. The agent's own record of having
		// asked is gone — a CLI resuming after its process died drops the dangling
		// tool call — so a bare "React" would arrive as an answer to nothing.
		const sent = onSendAsMessage.mock.calls[0][0] as string;
		expect(sent).toContain("Which framework?");
		expect(sent).toContain("React");
	});

	// Writing a late answer back onto the request would put live state into an
	// immutable record, and would then have to explain an "Answered" chip on a
	// tool call that never got a result. The user's own message is the receipt.
	it("records nothing on the card itself", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={request}
				status="expired"
				onSendAsMessage={vi.fn()}
			/>,
		);

		await openCard(user);
		await user.click(screen.getByRole("radio", { name: /The web one/ }));
		await user.click(screen.getByRole("button", { name: "Send as message" }));

		expect(screen.getByText("Expired")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Submit" }),
		).not.toBeInTheDocument();
	});

	// Which of the three endings this was decides both what the card says and,
	// for one of them, whether it can be answered at all (docs/lifecycle-ui.md
	// §5.1).
	it("says which ending this was", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={request}
				status="expired"
				reason="timeout"
				onSendAsMessage={vi.fn()}
			/>,
		);

		await openCard(user);
		expect(screen.getByText(/not answered in time/)).toBeInTheDocument();
	});

	// A closed work is the one ending with nobody to pick the answer up: sending
	// it as a message would start a turn on a session nobody is coming back to.
	it("cannot be answered once the work is closed", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={request}
				status="expired"
				reason="work_closed"
				onSendAsMessage={vi.fn()}
			/>,
		);

		await openCard(user);
		expect(screen.getByText(/the work was closed/)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Send as message" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /The web one/ })).toBeDisabled();
	});

	// Without a host that can send one, the offer would be a dead end — but what
	// happened is still known, and is still worth saying.
	it("is read-only when nothing can carry the message", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={request}
				status="expired"
				reason="timeout"
			/>,
		);

		await openCard(user);
		expect(screen.getByRole("radio", { name: /The web one/ })).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: "Send as message" }),
		).not.toBeInTheDocument();
		expect(screen.getByText(/not answered in time/)).toBeInTheDocument();
		expect(screen.queryByText(/You can still answer/)).not.toBeInTheDocument();
	});

	// The server's own reason, shown where the user was looking when they
	// pressed (docs/lifecycle-ui.md §8).
	it("shows why an answer was refused", async () => {
		const user = setupUser();
		render(
			<AskUserQuestionItem
				request={request}
				status="expired"
				onSendAsMessage={vi.fn()}
				error="session is no longer running, send a message to continue"
			/>,
		);

		await openCard(user);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"session is no longer running",
		);
	});
});
