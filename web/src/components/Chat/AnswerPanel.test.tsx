import { Sheet } from "@pockode/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_DRAFT,
	questionDraftActions,
	useQuestionDraftStore,
} from "../../lib/questionDraftStore";
import type { PendingQuestion } from "../../types/message";
import AnswerPanel from "./AnswerPanel";

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

function renderPanel(
	unanswered: PendingQuestion[],
	onSend = vi.fn().mockResolvedValue(undefined),
) {
	const onClose = vi.fn();
	const result = render(
		<AnswerPanel
			sessionId="s1"
			unanswered={unanswered}
			onSend={onSend}
			onClose={onClose}
			takeFocus
		/>,
	);
	return { ...result, onSend, onClose };
}

// jsdom does not scroll. Where a jump lands is the browser's business; that it
// is asked for, and asked for again, is this component's.
const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;

beforeEach(() => {
	useQuestionDraftStore.setState({ drafts: {} });
	scrollIntoView.mockClear();
});

describe("AnswerPanel", () => {
	// jsdom lays nothing out, so the shape can only be read off the classes it
	// is written in — worth pinning all the same, because both halves of it are
	// what the panel was reshaped for: a card the user's eye lands on, over a
	// backdrop that stops at the transcript's edges.
	it("is a centred card over a backdrop that covers the transcript", () => {
		renderPanel([database]);
		const panel = screen.getByRole("dialog", { name: /question/ });
		// Capped against the rectangle, so it cannot grow past the conversation
		// it is centred in; uncapped in the other direction, so one short
		// question is a card and not a wall.
		expect(panel).toHaveClass("max-h-[85%]", "max-w-2xl", "rounded-xl");
		expect(panel).not.toHaveClass("h-full");

		// The backdrop is `absolute`, never `fixed`: it is positioned against
		// ChatPanel's wrapper around the transcript, so the composer, the strip
		// and the session header below and above it stay lit.
		const backdrop = screen.getByTestId("answer-panel-backdrop");
		expect(backdrop).toHaveClass("absolute", "inset-0", "bg-th-bg-overlay");
		expect(backdrop).not.toHaveClass("fixed");

		// Not `aria-modal`: those three are still reachable, and saying otherwise
		// would take them away from a screen reader alone.
		expect(panel).not.toHaveAttribute("aria-modal");
	});

	// The backdrop is what makes "outside" mean anything, so pressing it is the
	// dismissal every user of a dimmed screen already expects.
	it("closes when the backdrop is pressed", async () => {
		const user = userEvent.setup();
		const { onClose } = renderPanel([database]);
		await user.click(screen.getByTestId("answer-panel-backdrop"));
		expect(onClose).toHaveBeenCalled();
	});

	// Selecting a question's text by dragging past the edge of the card ends
	// with the pointer over the backdrop, but `click` fires on what the press
	// and the release have in common — the centring container, not the backdrop
	// — and reading a dismissal out of that would take the panel away mid-drag.
	it("stays put when a press only ends over the backdrop", () => {
		const { onClose } = renderPanel([database]);
		const container = screen.getByTestId("answer-panel-backdrop").parentElement;
		if (!container) throw new Error("backdrop has no container");
		fireEvent.click(container);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("titles itself with the live count and counts what is ready", () => {
		renderPanel([database, region]);
		expect(screen.getByText("2 questions")).toBeInTheDocument();
		expect(screen.getByText("0 of 2 ready")).toBeInTheDocument();
	});

	// A question with no options is the shape a free-text request takes, and it
	// needs no second surface and no second copy.
	it("draws a question with no options as free text", () => {
		renderPanel([region]);
		expect(screen.getByPlaceholderText("Your answer")).toBeInTheDocument();
	});

	// **Other** is not the same lever as "Won't answer" and neither replaces the
	// other: Other is "my answer is something else", declining is "I am not
	// answering this". Recording the first as the second would tell the agent the
	// user refused and throw away the most useful sentence on the screen.
	it("offers an Other row beside a question's options", () => {
		renderPanel([database]);
		expect(screen.getByRole("radio", { name: /Other/ })).toBeInTheDocument();
		expect(screen.getAllByRole("radio")).toHaveLength(3);
	});

	// The user's own words go in `text`, never among the labels. The label check
	// exists so the agent is not told it was handed back a choice it never gave;
	// it is not there to stop the user saying something else.
	it("sends what the user typed apart from the labels", async () => {
		const user = userEvent.setup();
		const { onSend } = renderPanel([database]);

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
		renderPanel([database]);

		await user.click(screen.getByRole("radio", { name: /Other/ }));

		expect(screen.getByText("0 of 1 ready")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("sends nothing but the labels the question offered when Other is unused", async () => {
		const user = userEvent.setup();
		const { onSend } = renderPanel([
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
		const { onSend } = renderPanel([database]);

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
		const { onSend } = renderPanel([database, region]);

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
		const { onClose } = renderPanel([database, region]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onClose).not.toHaveBeenCalled();
		expect(await screen.findByText("1 answer sent.")).toBeInTheDocument();
	});

	it("clears a draft only once its own submit lands", async () => {
		const user = userEvent.setup();
		renderPanel([database]);

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
		renderPanel([database], onSend);

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
		renderPanel([database], onSend);

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
		const { onSend } = renderPanel([region]);

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
		renderPanel([database]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("checkbox", { name: /Won't answer/ }));

		expect(useQuestionDraftStore.getState().drafts.s1?.r1.labels).toEqual([
			"SQLite",
		]);
	});

	// A panel that vanished under a finger would make its own disappearance the
	// notification that somebody else answered.
	it("stays open and offers a way out when the list empties from elsewhere", () => {
		const { rerender, onClose } = renderPanel([database]);
		rerender(
			<AnswerPanel
				sessionId="s1"
				unanswered={[]}
				onSend={vi.fn()}
				onClose={onClose}
				takeFocus
			/>,
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByText("Nothing left to answer.")).toBeInTheDocument();
		// Two buttons say Close here — the panel's own × and the footer's — and
		// both do the same thing. The footer's is the one that replaced Send.
		expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
		expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
	});

	it("closes itself once a submit leaves nothing behind", async () => {
		const user = userEvent.setup();
		const { rerender, onClose, onSend } = renderPanel([database]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(onSend).toHaveBeenCalled();

		rerender(
			<AnswerPanel
				sessionId="s1"
				unanswered={[]}
				onSend={onSend}
				onClose={onClose}
				takeFocus
			/>,
		);
		expect(onClose).toHaveBeenCalled();
	});

	// The turn update resolving a question and the send's response come down
	// different channels in no promised order. Update first used to read as the
	// question leaving with a draft — somebody else's answer — and the grey block
	// that left behind kept the panel from ever closing itself.
	describe("when the turn update lands before the send's response", () => {
		function deferredSend() {
			const deliveries: Array<() => void> = [];
			const failures: Array<(err: Error) => void> = [];
			const onSend = vi.fn(
				() =>
					new Promise<void>((resolve, reject) => {
						deliveries.push(resolve);
						failures.push(reject);
					}),
			);
			return {
				onSend,
				deliver: () => act(async () => deliveries.shift()?.()),
				fail: (err: Error) => act(async () => failures.shift()?.(err)),
			};
		}

		function relist(
			rerender: ReturnType<typeof render>["rerender"],
			unanswered: PendingQuestion[],
			onSend: ComponentProps<typeof AnswerPanel>["onSend"],
			onClose: () => void,
		) {
			rerender(
				<AnswerPanel
					sessionId="s1"
					unanswered={unanswered}
					onSend={onSend}
					onClose={onClose}
					takeFocus
				/>,
			);
		}

		it("does not mistake its own answer for one given elsewhere, and closes once delivered", async () => {
			const user = userEvent.setup();
			const { onSend, deliver } = deferredSend();
			const { rerender, onClose } = renderPanel([database], onSend);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			await user.click(screen.getByRole("button", { name: "Send" }));
			relist(rerender, [], onSend, onClose);

			expect(
				screen.queryByText("Already answered elsewhere."),
			).not.toBeInTheDocument();
			// Every way out stands down until the response says it went out,
			// including the footer's button that replaces Send once the list
			// empties — which goes on saying the send is still out.
			expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
			expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
			await user.click(screen.getByTestId("answer-panel-backdrop"));
			await user.keyboard("{Escape}");
			expect(onClose).not.toHaveBeenCalled();

			await deliver();
			expect(onClose).toHaveBeenCalled();
		});

		it("stays open through each submit until that one is delivered", async () => {
			const user = userEvent.setup();
			const { onSend, deliver } = deferredSend();
			const { rerender, onClose } = renderPanel([database, region], onSend);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			await user.click(screen.getByRole("button", { name: "Send" }));
			relist(rerender, [region], onSend, onClose);
			await deliver();
			expect(onClose).not.toHaveBeenCalled();

			await user.type(screen.getByPlaceholderText("Your answer"), "eu");
			await user.click(screen.getByRole("button", { name: "Send" }));
			// The first submit's "1 answer sent." is still counted here, and the
			// list is empty: only the send in flight keeps the panel up.
			relist(rerender, [], onSend, onClose);
			expect(onClose).not.toHaveBeenCalled();
			expect(
				screen.queryByText("Already answered elsewhere."),
			).not.toBeInTheDocument();

			await deliver();
			expect(onClose).toHaveBeenCalled();
		});

		it("still greys out a question answered elsewhere during the send", async () => {
			const user = userEvent.setup();
			const { onSend, deliver } = deferredSend();
			const { rerender, onClose } = renderPanel([database, region], onSend);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			// Worked on but not ready, so it stays behind when r1 goes out.
			act(() =>
				questionDraftActions.set("s1", "r2", {
					...EMPTY_DRAFT,
					note: "ask ops",
				}),
			);
			expect(screen.getByText("1 of 2 ready")).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Send" }));
			relist(rerender, [], onSend, onClose);

			const stale = await screen.findAllByText("Already answered elsewhere.");
			expect(stale).toHaveLength(1);
			expect(
				stale[0]
					.closest("[data-answer-block]")
					?.getAttribute("data-answer-block"),
			).toBe("r2");

			await deliver();
			expect(onClose).not.toHaveBeenCalled();
		});

		it("greys out a block that left while its send failed", async () => {
			const user = userEvent.setup();
			const { onSend, fail } = deferredSend();
			const { rerender, onClose } = renderPanel([database], onSend);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			await user.click(screen.getByRole("button", { name: "Send" }));
			relist(rerender, [], onSend, onClose);
			await fail(new Error("connection lost"));

			expect(
				await screen.findByText("Already answered elsewhere."),
			).toBeInTheDocument();
			expect(useQuestionDraftStore.getState().drafts.s1?.r1.labels).toEqual([
				"SQLite",
			]);
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	// A block that held nothing is not a loss, so nothing is announced.
	it("drops a block that leaves holding no draft", () => {
		const { rerender, onClose } = renderPanel([database, region]);
		rerender(
			<AnswerPanel
				sessionId="s1"
				unanswered={[region]}
				onSend={vi.fn()}
				onClose={onClose}
				takeFocus
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
		const { rerender, onClose } = renderPanel([database, region]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		rerender(
			<AnswerPanel
				sessionId="s1"
				unanswered={[region]}
				onSend={vi.fn()}
				onClose={onClose}
				takeFocus
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

	// A slow relay would otherwise leave the user with no way to tell a submit
	// that went out from one that was cancelled on the way.
	it("cannot be closed while a submit is in flight", async () => {
		const user = userEvent.setup();
		let deliver: (() => void) | undefined;
		const onSend = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					deliver = resolve;
				}),
		);
		const { onClose } = renderPanel([database], onSend);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		const close = screen.getByRole("button", { name: "Close" });
		expect(close).toBeDisabled();
		await user.keyboard("{Escape}");
		await user.click(screen.getByTestId("answer-panel-backdrop"));
		expect(onClose).not.toHaveBeenCalled();

		deliver?.();
		await screen.findByText("1 answer sent.");
	});

	// Focus lands on the panel itself, not on its first control: first in the
	// DOM is the close button, and landing there would read out "Close" and put
	// one stray Enter between the user and the questions they came for.
	it("reads itself out when the user asked for it", () => {
		renderPanel([database]);
		expect(screen.getByRole("dialog", { name: "1 question" })).toHaveFocus();
	});

	// The other half of `takeFocus`: nothing on screen moves the caret when the
	// panel was not asked for. The composer stays typeable, which is the whole
	// reason it is not a modal.
	it("leaves the caret alone when nobody asked for it", () => {
		render(
			<>
				{/* biome-ignore lint/a11y/noAutofocus: stands in for the composer the user was typing in. */}
				<textarea autoFocus data-testid="composer" />
				<AnswerPanel
					sessionId="s1"
					unanswered={[database]}
					onSend={vi.fn()}
					onClose={vi.fn()}
					takeFocus={false}
				/>
			</>,
		);
		expect(screen.getByTestId("composer")).toHaveFocus();
	});

	// The panel shows itself and then stays up, so a user naming a question —
	// from the work detail's `Answer` — is usually naming it to a panel that is
	// already open, and on a second naming it would otherwise sit still.
	it("scrolls to each question a user names, not only the first", () => {
		const { rerender } = render(
			<AnswerPanel
				sessionId="s1"
				unanswered={[database, region]}
				anchorRequestId="r1"
				onSend={vi.fn()}
				onClose={vi.fn()}
				takeFocus
			/>,
		);
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		rerender(
			<AnswerPanel
				sessionId="s1"
				unanswered={[database, region]}
				anchorRequestId="r2"
				onSend={vi.fn()}
				onClose={vi.fn()}
				takeFocus
			/>,
		);
		expect(scrollIntoView).toHaveBeenCalledTimes(2);
	});

	// Escape is the chat's interrupt everywhere else, and the panel takes it for
	// as long as it is up: it does not hold focus, so the press that means "put
	// this away" is usually made at the composer or at the dimmed transcript,
	// and reading it as an interrupt would end the agent's turn for good.
	// ChatPanel stands its own listener down to match.
	it("closes on Escape pressed anywhere while it is up", async () => {
		const user = userEvent.setup();
		const { onClose } = renderPanel([database]);
		act(() => document.body.focus());
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	// ...but only the top layer answers one press. A message's menu open at the
	// moment a question arrives stays open — the panel dims the transcript, it
	// does not take the user off it, so a sheet they were part-way through is
	// still theirs — which leaves a `Sheet` genuinely over this panel. It
	// listens on `document`, which this panel's `window` listener sits past on
	// purpose, and claims the press it closes on (docs/answering-ui.md §4,
	// "Who owns Escape", rule 1). Without the claim one Escape takes both, and
	// the panel goes with answers half filled in.
	it("stays up when a sheet over it takes the press", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		const onMenuClose = vi.fn();
		render(
			<>
				<AnswerPanel
					sessionId="s1"
					unanswered={[database]}
					onSend={vi.fn()}
					onClose={onClose}
					takeFocus={false}
				/>
				<Sheet title="Agent message" onClose={onMenuClose}>
					<button type="button">Fork from here</button>
				</Sheet>
			</>,
		);

		await user.keyboard("{Escape}");

		expect(onMenuClose).toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	// ...including the sheet that refuses the press. `ForkSessionSheet` goes
	// non-dismissible while the fork is in flight, and that is reachable from
	// the very menu above, so the panel can be underneath one. Its backdrop
	// swallows the equivalent click either way — it is drawn whether or not it
	// dismisses — and a key that fell through instead would answer "cancel this"
	// by putting away the panel behind it.
	it("stays up when a sheet over it refuses the press", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		const onForkClose = vi.fn();
		render(
			<>
				<AnswerPanel
					sessionId="s1"
					unanswered={[database]}
					onSend={vi.fn()}
					onClose={onClose}
					takeFocus={false}
				/>
				<Sheet title="Fork session" onClose={onForkClose} dismissible={false}>
					<button type="button">Fork</button>
				</Sheet>
			</>,
		);

		await user.keyboard("{Escape}");

		expect(onForkClose).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	// Whether the caret is in this card is the second of the three conditions
	// that fold the screen around it on a short viewport (docs/answering-ui.md
	// §3). The card only reports it; what it must never report is a departure
	// that is really a move between two of its own controls. `focusout` is
	// dispatched before the matching `focusin`, so a false "left" would unmount
	// the composer and mount it again under the user — and an `InputBar` that
	// mounts takes the caret with it.
	describe("reporting whether focus is inside it", () => {
		const renderWithNeighbour = (onFocusChange: (focused: boolean) => void) =>
			render(
				<>
					<AnswerPanel
						sessionId="s1"
						unanswered={[database]}
						onSend={vi.fn()}
						onClose={vi.fn()}
						takeFocus={false}
						onFocusChange={onFocusChange}
					/>
					{/* Lit, reachable screen of the kind the backdrop leaves alone: the
					    session header, the strip, the composer (§3). */}
					<button type="button">outside</button>
				</>,
			);

		it("says nothing new as the caret moves between its own controls", async () => {
			const user = userEvent.setup();
			const onFocusChange = vi.fn();
			renderWithNeighbour(onFocusChange);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			expect(onFocusChange).toHaveBeenLastCalledWith(true);

			onFocusChange.mockClear();
			await user.click(screen.getByRole("radio", { name: /Postgres/ }));
			expect(onFocusChange).not.toHaveBeenCalledWith(false);
		});

		it("reports the caret leaving for the screen around it", async () => {
			const user = userEvent.setup();
			const onFocusChange = vi.fn();
			renderWithNeighbour(onFocusChange);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			await user.click(screen.getByRole("button", { name: "outside" }));

			expect(onFocusChange).toHaveBeenLastCalledWith(false);
		});
	});

	// Whatever is drawn over this panel — a portalled dialog — owns the key
	// first, or one press would dismiss both.
	it("leaves an Escape another surface has already handled alone", async () => {
		const user = userEvent.setup();
		const claim = (e: KeyboardEvent) => {
			if (e.key === "Escape") e.preventDefault();
		};
		document.addEventListener("keydown", claim);
		try {
			const { onClose } = renderPanel([database]);
			await user.keyboard("{Escape}");
			expect(onClose).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", claim);
		}
	});
});
