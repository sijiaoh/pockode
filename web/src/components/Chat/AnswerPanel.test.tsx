import { Sheet } from "@pockode/shared";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	// With the host's chrome folded on a short viewport the card is all that is
	// left to answer in, so it takes the room: the whole rectangle, and the
	// header folded into a footer cut to Send's 44px — that is the one row the
	// user must reach with the keyboard up. The dialog keeps its name, and there
	// is still exactly one way to close it.
	it("takes the whole rectangle and folds its header into the footer when the chrome is folded", () => {
		const props = {
			sessionId: "s1",
			unanswered: [database],
			onSend: vi.fn(),
			onClose: vi.fn(),
			takeFocus: false,
		};
		const { rerender } = render(<AnswerPanel {...props} />);
		const panel = screen.getByRole("dialog", { name: "1 question" });
		expect(screen.getByRole("heading", { name: "1 question" })).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Send" }).parentElement,
		).toHaveClass("py-4");

		rerender(<AnswerPanel {...props} chromeCollapsed />);

		expect(panel).toHaveClass("max-h-full");
		expect(panel).not.toHaveClass("max-h-[85%]");
		expect(screen.getByRole("dialog", { name: "1 question" })).toBe(panel);
		expect(screen.getByRole("heading", { name: "1 question" })).toHaveClass(
			"sr-only",
		);
		const send = screen.getByRole("button", { name: "Send" });
		const footer = send.parentElement;
		expect(footer).toHaveClass("py-1");
		expect(send).toHaveClass("min-h-[44px]");
		const close = screen.getByRole("button", { name: "Close" });
		expect(footer).toContainElement(close);
		// At the far end from Send, so a thumb aimed at one misses the other.
		expect(footer?.firstElementChild).toBe(close);
	});

	// The browser scrolls a focused field into view when focus arrives, at
	// best; it does nothing when the soft keyboard then shortens the body, or
	// the field grows a line — and on a short viewport either puts the caret
	// behind the footer. jsdom lays nothing out, so the geometry is stated.
	describe("keeping the field being typed in on screen", () => {
		const place = (el: Element, top: number, bottom: number) => {
			el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
		};
		// jsdom's scrollTop is always 0; this one remembers what it was set to.
		const scrollable = (el: HTMLElement) => {
			let top = 0;
			Object.defineProperty(el, "scrollTop", {
				get: () => top,
				set: (value: number) => {
					top = value;
				},
			});
		};

		it("scrolls the body so the focused field and a line below it are in view", () => {
			renderPanel([database]);
			const field = screen.getByRole("textbox", {
				name: "Other answer for Database",
			});
			const body = screen.getByRole("dialog").querySelector(".overflow-y-auto");
			if (!(body instanceof HTMLElement)) throw new Error("no body");
			scrollable(body);
			place(body, 100, 218);
			place(field, 200, 236);

			act(() => field.focus());

			// 236 + one 24px line, against a bottom at 218.
			expect(body.scrollTop).toBe(42);
		});

		it("leaves the body alone for a field already in view, and for a pick", () => {
			renderPanel([database]);
			const body = screen.getByRole("dialog").querySelector(".overflow-y-auto");
			if (!(body instanceof HTMLElement)) throw new Error("no body");
			scrollable(body);
			place(body, 100, 400);
			const field = screen.getByRole("textbox", {
				name: "Other answer for Database",
			});
			place(field, 200, 236);
			const radio = screen.getByRole("radio", { name: /SQLite/ });
			place(radio, 500, 516);

			act(() => field.focus());
			act(() => radio.focus());

			expect(body.scrollTop).toBe(0);
		});

		// The two cases the browser leaves alone, both of which arrive as a
		// resize: the global stub resizes nothing, so this one hands the test the
		// callback and the boxes it was asked to watch.
		describe("when something changes size under a focused field", () => {
			let watched: Set<Element>;
			let resized: () => void;
			beforeEach(() => {
				watched = new Set();
				vi.stubGlobal(
					"ResizeObserver",
					class {
						constructor(callback: () => void) {
							resized = () => act(callback);
						}
						observe(target: Element) {
							watched.add(target);
						}
						unobserve(target: Element) {
							watched.delete(target);
						}
						disconnect() {
							watched.clear();
						}
					},
				);
			});
			afterEach(() => {
				vi.unstubAllGlobals();
			});

			const setUp = () => {
				renderPanel([database]);
				const field = screen.getByRole("textbox", {
					name: "Other answer for Database",
				});
				const body = screen
					.getByRole("dialog")
					.querySelector(".overflow-y-auto");
				if (!(body instanceof HTMLElement)) throw new Error("no body");
				scrollable(body);
				place(body, 100, 400);
				place(field, 200, 236);
				act(() => field.focus());
				expect(body.scrollTop).toBe(0);
				return { body, field };
			};

			it("follows the keyboard shortening the body", () => {
				const { body } = setUp();
				expect(watched.has(body)).toBe(true);

				place(body, 100, 230);
				resized();

				expect(body.scrollTop).toBe(30);
			});

			it("follows the field growing a line, and stops once it is left", () => {
				const { body, field } = setUp();
				expect(watched.has(field)).toBe(true);

				place(field, 200, 400);
				resized();
				expect(body.scrollTop).toBe(24);

				act(() => field.blur());
				expect(watched.has(field)).toBe(false);
				place(field, 200, 500);
				resized();
				expect(body.scrollTop).toBe(24);
			});

			// Above the view, it comes back down only as far as its end allows:
			// the end is where the caret is.
			it("brings a field above the view back without losing its end", () => {
				const { body, field } = setUp();
				body.scrollTop = 100;

				place(field, 50, 376);
				resized();

				// 74px short at the top, and its end plus a line exactly fills the view.
				expect(body.scrollTop).toBe(100);

				place(field, 50, 300);
				resized();
				// Now 76px to spare below; the top needs 74 of it.
				expect(body.scrollTop).toBe(26);
			});
		});
	});

	// One `question_post` call stamps every question with the same `asked_at`,
	// so the order they were asked in is the list's order and nothing else.
	// The headers run against the alphabet, so a sort on them shows too.
	it("draws a batch in the order of the session's list", () => {
		const askedAt = "2026-01-02T14:02:00.000000001Z";
		const headers = ["Gamma", "Alpha", "Beta"];
		renderPanel(
			headers.map((header, i) => ({
				...region,
				request_id: `b${i}`,
				header,
				question: `${header}?`,
				asked_at: askedAt,
			})),
		);

		expect(
			screen
				.getAllByText(/^(Gamma|Alpha|Beta)$/)
				.map((chip) => chip.textContent),
		).toEqual(headers);
	});

	// No limit on how many questions or options arrive, so the body is what
	// scrolls: it takes the card's leftover height (`min-h-0 flex-1`) and
	// scrolls inside it, while the Send footer stays outside it, in reach.
	it("scrolls its questions inside the card, keeping Send outside them", () => {
		renderPanel([database, region]);

		const body = screen.getByText("Which region?").closest(".overflow-y-auto");
		expect(body).toHaveClass("min-h-0", "flex-1");
		expect(body).toContainElement(
			screen.getByText("Which database should I use?"),
		);
		expect(body).not.toContainElement(
			screen.getByRole("button", { name: "Send" }),
		);
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

	// A recommendation is a hint, never a selection: preselecting it would let
	// one press of Send answer for the user with something they never read.
	it("picks nothing for the user when an option is recommended", () => {
		renderPanel([
			{
				...database,
				options: [
					{ label: "Postgres", description: "Managed", recommended: true },
					{ label: "SQLite", description: "One file" },
				],
			},
		]);
		expect(screen.getByText("Recommended")).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /Postgres/ })).not.toBeChecked();
		expect(screen.getByText("0 of 1 ready")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
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
			screen.getByRole("textbox", { name: "Other answer for Database" }),
			"MySQL",
		);
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend.mock.calls[0][0]).toMatchObject([
			{ request_id: "r1", answers: [], text: "MySQL" },
		]);
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

		expect(onSend.mock.calls[0][0]).toMatchObject([
			{ request_id: "r1", answers: ["Postgres", "SQLite"] },
		]);
		expect(onSend.mock.calls[0][0][0].text).toBeUndefined();
	});

	// Radios are exclusive and Other is one of them. The text is kept in the
	// draft so the user can change their mind back without retyping, but sending
	// it would answer with something they have taken back.
	it("does not send Other text the user has since unpicked", async () => {
		const user = userEvent.setup();
		const { onSend } = renderPanel([database]);

		await user.click(screen.getByRole("radio", { name: /Other/ }));
		await user.type(
			screen.getByRole("textbox", { name: "Other answer for Database" }),
			"MySQL",
		);
		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		// Kept on screen, not just in the draft: hidden, it would read as lost.
		// The box is not part of the radio's label, so its text is not read out
		// as the option's name.
		expect(screen.getByRole("radio", { name: "Other" })).not.toBeChecked();
		expect(
			screen.getByRole("textbox", { name: "Other answer for Database" }),
		).toHaveValue("MySQL");
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend.mock.calls[0][0]).toMatchObject([
			{ request_id: "r1", answers: ["SQLite"] },
		]);
		expect(onSend.mock.calls[0][0][0].text).toBeUndefined();
	});

	describe("the Other input", () => {
		const otherInput = () =>
			screen.getByRole("textbox", { name: "Other answer for Database" });

		// Going into the box is how the user says "something else"; making them
		// tick the row first is a step they skip and then wonder why Send is off.
		it("picks Other when the user clicks into it", async () => {
			const user = userEvent.setup();
			renderPanel([database]);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			await user.click(otherInput());

			expect(screen.getByRole("radio", { name: /Other/ })).toBeChecked();
			expect(screen.getByRole("radio", { name: /SQLite/ })).not.toBeChecked();
		});

		// Tab passes through the box on its way to the note. Picking on focus
		// would silently swap out the radio the user already chose.
		it("does not pick Other when focus only passes through it", async () => {
			const user = userEvent.setup();
			renderPanel([database]);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			otherInput().focus();

			expect(screen.getByRole("radio", { name: /SQLite/ })).toBeChecked();
			expect(screen.getByRole("radio", { name: /Other/ })).not.toBeChecked();
		});

		it("picks Other when the user types in it, and sends what was typed", async () => {
			const user = userEvent.setup();
			const { onSend } = renderPanel([database]);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			otherInput().focus();
			await user.keyboard("MySQL");
			await user.click(screen.getByRole("button", { name: "Send" }));

			expect(onSend.mock.calls[0][0]).toMatchObject([
				{ request_id: "r1", answers: [], text: "MySQL" },
			]);
		});

		// In a multiple choice Other is one more pick: going into the box adds
		// it beside the rest, and never unticks it.
		it("adds Other beside the other picks of a multiple choice", async () => {
			const user = userEvent.setup();
			renderPanel([{ ...database, multi_select: true }]);

			await user.click(screen.getByRole("checkbox", { name: /Postgres/ }));
			await user.click(otherInput());
			await user.click(otherInput());

			expect(screen.getByRole("checkbox", { name: /Postgres/ })).toBeChecked();
			expect(screen.getByRole("checkbox", { name: /Other/ })).toBeChecked();
		});

		// Answers that arrive here can be sentences; Enter must not end them.
		it("takes more than one line", async () => {
			const user = userEvent.setup();
			renderPanel([database]);

			await user.type(otherInput(), "MySQL{Enter}but only 8");

			expect(otherInput()).toHaveValue("MySQL\nbut only 8");
		});
	});

	describe("the count of picks", () => {
		// Ticked Other counts while still empty: the count says what is ticked,
		// not what is ready to send — the footer says that.
		it("counts what a multiple choice has ticked, Other included", async () => {
			const user = userEvent.setup();
			renderPanel([{ ...database, multi_select: true }]);

			expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
			await user.click(screen.getByRole("checkbox", { name: /Postgres/ }));
			expect(screen.getByText("1 selected")).toBeInTheDocument();
			await user.click(screen.getByRole("checkbox", { name: /Other/ }));
			expect(screen.getByText("2 selected")).toBeInTheDocument();
		});

		// A single choice is always one; counting it says nothing.
		it("is not shown for a single choice", async () => {
			const user = userEvent.setup();
			renderPanel([database]);

			await user.click(screen.getByRole("radio", { name: /Postgres/ }));

			expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
		});
	});

	it("sends one message for every block that is ready", async () => {
		const user = userEvent.setup();
		const { onSend } = renderPanel([database, region]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onSend.mock.calls[0][0]).toMatchObject([
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

	// The body stays where the user was reading, so the receipt goes where it is
	// always seen — the footer, in the ready count's place — and into a status
	// region that is there before it, which is what gets it read out. The next
	// change is about what is left, so the count comes back.
	it("says what a partial submit sent in the footer, until the next change", async () => {
		const user = userEvent.setup();
		renderPanel([database, region]);
		const status = screen.getByRole("status");
		expect(status).toBeEmptyDOMElement();

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => expect(status).toHaveTextContent("1 answer sent."));
		expect(screen.queryByText(/ready$/)).not.toBeInTheDocument();

		await user.type(screen.getByRole("textbox", { name: "Region" }), "eu");
		expect(status).toBeEmptyDOMElement();
		expect(screen.getByText(/ready$/)).toBeInTheDocument();
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

		expect(onSend.mock.calls[0][0]).toMatchObject([
			{ request_id: "r2", declined: true, note: "ask ops" },
		]);
	});

	// Both go out as the record's one `note`, so nothing but the draft keeps a
	// reason for refusing from turning into a remark on the answer, or back.
	it("keeps a decline's note and an answer's note apart", async () => {
		const user = userEvent.setup();
		const { onSend } = renderPanel([database]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Add a note" }));
		await user.type(
			screen.getByRole("textbox", { name: "Note for Database" }),
			"pin it",
		);
		await user.click(screen.getByRole("checkbox", { name: /Won't answer/ }));
		await user.type(
			screen.getByPlaceholderText("Add a note (optional)"),
			"ask ops",
		);
		await user.click(screen.getByRole("checkbox", { name: /Won't answer/ }));
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend.mock.calls[0][0]).toMatchObject([
			{ request_id: "r1", answers: ["SQLite"], note: "pin it" },
		]);
	});

	// iOS Safari zooms into any field it focuses below 16px, cropping the card.
	// Read off the classes, as jsdom evaluates no media query; every kind of
	// field the panel offers is up at once so a new one cannot slip past.
	it("types at 16px, padded alike, in every field under a thumb", async () => {
		const user = userEvent.setup();
		renderPanel([
			database,
			region,
			{ ...region, request_id: "r3", header: "Owner" },
		]);

		await user.click(screen.getByRole("radio", { name: /SQLite/ }));
		await user.click(screen.getByRole("button", { name: "Add a note" }));
		const [, , ownerDecline] = screen.getAllByRole("checkbox", {
			name: /Won't answer/,
		});
		await user.click(ownerDecline);

		const fields = screen.getAllByRole("textbox");
		// Other, the note, Region's free text, Owner's decline note.
		expect(fields).toHaveLength(4);
		for (const field of fields) {
			expect(field).toHaveClass(
				"text-sm",
				"pointer-coarse:text-base",
				"pointer-coarse:py-2",
			);
		}
	});

	describe("the note beside an answer", () => {
		it("is offered once something is picked, and sent with it", async () => {
			const user = userEvent.setup();
			const { onSend } = renderPanel([database]);
			expect(
				screen.queryByRole("button", { name: "Add a note" }),
			).not.toBeInTheDocument();

			await user.click(screen.getByRole("radio", { name: /Postgres/ }));
			await user.click(screen.getByRole("button", { name: "Add a note" }));
			// The press was a request to type, so the caret is already there.
			const note = screen.getByRole("textbox", { name: "Note for Database" });
			expect(note).toHaveFocus();
			await user.keyboard("pin it to 16");
			await user.click(screen.getByRole("button", { name: "Send" }));

			expect(onSend.mock.calls[0][0]).toMatchObject([
				{ request_id: "r1", answers: ["Postgres"], note: "pin it to 16" },
			]);
		});

		// Other is already the user's own words, and a question with no options
		// has nothing for a remark to sit beside: the server refuses both.
		it("is not offered beside a single Other or a free-text answer", async () => {
			const user = userEvent.setup();
			renderPanel([database, region]);

			await user.click(screen.getByRole("radio", { name: /Other/ }));
			await user.type(
				screen.getByRole("textbox", { name: "Other answer for Database" }),
				"MySQL",
			);
			await user.type(screen.getByRole("textbox", { name: "Region" }), "eu");

			expect(
				screen.queryByRole("button", { name: "Add a note" }),
			).not.toBeInTheDocument();
		});

		// Beside several picks, Other is one more of them.
		it("is offered beside Other in a multiple choice", async () => {
			const user = userEvent.setup();
			renderPanel([{ ...database, multi_select: true }]);

			await user.click(screen.getByRole("checkbox", { name: /Other/ }));

			expect(
				screen.getByRole("button", { name: "Add a note" }),
			).toBeInTheDocument();
		});

		// Unpicking is trying something else, not throwing the note away: it
		// stays on screen and in the draft, and simply is not sent.
		it("is kept, but not sent, while nothing it can go beside is picked", async () => {
			const user = userEvent.setup();
			const { onSend } = renderPanel([database]);

			await user.click(screen.getByRole("radio", { name: /SQLite/ }));
			await user.click(screen.getByRole("button", { name: "Add a note" }));
			await user.keyboard("pin it");
			await user.click(screen.getByRole("radio", { name: /Other/ }));
			await user.type(
				screen.getByRole("textbox", { name: "Other answer for Database" }),
				"MySQL",
			);

			expect(
				screen.getByRole("textbox", { name: "Note for Database" }),
			).toHaveValue("pin it");
			expect(
				screen.getByText("Not sent with Other — add it to your answer above."),
			).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Send" }));
			expect(onSend.mock.calls[0][0][0]).toMatchObject({ text: "MySQL" });
			expect(onSend.mock.calls[0][0][0].note).toBeUndefined();
		});

		it("says why a kept note is not sent when nothing is picked", async () => {
			const user = userEvent.setup();
			renderPanel([{ ...database, multi_select: true }]);

			await user.click(screen.getByRole("checkbox", { name: /Postgres/ }));
			await user.click(screen.getByRole("button", { name: "Add a note" }));
			await user.keyboard("pin it");
			await user.click(screen.getByRole("checkbox", { name: /Postgres/ }));

			expect(
				screen.getByRole("textbox", { name: "Note for Database" }),
			).toHaveAccessibleDescription("Not sent until you pick an option.");
		});

		// A box that went away as its last character was deleted would take the
		// caret with it, mid-edit.
		it("does not vanish from under the caret when emptied", async () => {
			const user = userEvent.setup();
			questionDraftActions.set("s1", "r1", {
				...EMPTY_DRAFT,
				answerNote: "x",
			});
			renderPanel([database]);

			const note = screen.getByRole("textbox", { name: "Note for Database" });
			await user.click(note);
			await user.keyboard("{Backspace}");

			expect(note).toBeInTheDocument();
			expect(note).toHaveFocus();
		});

		// What a reload puts back: the store is persisted, so the panel only has
		// to draw what it holds.
		it("comes back from the draft as a box, not a button", () => {
			questionDraftActions.set("s1", "r1", {
				...EMPTY_DRAFT,
				labels: ["SQLite"],
				answerNote: "pin it",
			});
			renderPanel([database]);

			expect(
				screen.getByRole("textbox", { name: "Note for Database" }),
			).toHaveValue("pin it");
		});
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

	// What is dimmed is what the decline took out of play: the whole question,
	// header included. The lever that takes it back stays lit.
	it("dims a declined question as a whole, and not its Won't answer", async () => {
		const user = userEvent.setup();
		renderPanel([database]);

		await user.click(screen.getByRole("checkbox", { name: /Won't answer/ }));

		expect(screen.getByText("Database").closest(".opacity-60")).not.toBeNull();
		expect(
			screen
				.getByRole("checkbox", { name: /Won't answer/ })
				.closest(".opacity-60"),
		).toBeNull();
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
