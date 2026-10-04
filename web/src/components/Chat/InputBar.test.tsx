import { useHasCoarsePointer, useIsPageCovered } from "@pockode/shared";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChatAttachment,
	uploadChatAttachment,
} from "../../lib/chatAttachments";
import { useInputStore } from "../../lib/inputStore";
import {
	resetChatUIConfig,
	type SendOutcome,
	setChatUIConfig,
} from "../../lib/registries/chatUIRegistry";
import InputBar from "./InputBar";
import { ARM_MS } from "./SendStopSlot";

vi.mock("../../utils/platform", () => ({
	isMac: false,
}));

// Only the pointer gates are faked; the width hooks read the setup's matchMedia
// stub, which answers no to every min-width query (i.e. the compact tier).
vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	hasCoarsePointer: vi.fn(() => false),
	useHasCoarsePointer: vi.fn(() => false),
}));

// Mock textarea-caret for Y coordinate detection in history navigation
vi.mock("textarea-caret", () => ({
	default: vi.fn(() => ({ top: 0, left: 0, height: 20 })),
}));

import getCaretCoordinates from "textarea-caret";

const mockGetCaretCoordinates = getCaretCoordinates as Mock;

const mockListCommands = vi.fn();

const wsState = {
	actions: {
		listCommands: mockListCommands,
	},
	maxAttachmentSize: 1024,
};

vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		vi.fn((selector) => selector(wsState)),
		{ getState: () => wsState },
	),
}));

vi.mock("../../lib/chatAttachments", () => ({
	uploadChatAttachment: vi.fn(),
}));

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();

const HISTORY_KEY = "input_history";

const sendAccepted = async (): Promise<SendOutcome> => "sent";

const TEST_SESSION_ID = "test-session";

// The listbox is drawn the moment the input matches, but its options only once
// listCommands resolves; until then it reads "No matching commands", the same
// as an answer that matched nothing. A test about the palette's contents waits
// for the contents — `findAllByRole("option")` — and a test about an empty
// answer waits for the answer, since nothing on screen changes when it lands.
async function commandsLoaded() {
	expect(mockListCommands).toHaveBeenCalled();
	await act(() => mockListCommands.mock.results[0].value);
}

const mockCommands = [
	{ name: "help", isBuiltin: true },
	{ name: "model", isBuiltin: true },
	{ name: "memory", isBuiltin: true },
	{ name: "my-custom", isBuiltin: false },
];

describe("InputBar", () => {
	beforeEach(() => {
		localStorage.clear();
		mockListCommands.mockResolvedValue(mockCommands);
		mockGetCaretCoordinates.mockReturnValue({ top: 0, left: 0, height: 20 });
		vi.mocked(useHasCoarsePointer).mockReturnValue(false);
	});

	afterEach(() => {
		useInputStore.setState({ inputs: {}, attachments: {} });
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("disables send button when canSend is false", () => {
		render(
			<InputBar
				sessionId={TEST_SESSION_ID}
				onSend={sendAccepted}
				canSend={false}
			/>,
		);

		expect(screen.getByRole("textbox")).not.toBeDisabled();
		expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
	});

	// A refusal the user has to act on is said where they are about to type;
	// one that only passes (no `canSend`) keeps the ordinary prompt.
	it.each([
		[false, "Answer the permission request to send"],
		[true, /^Type a message/],
	])("puts the refusal reason in the placeholder only while refused (canSend: %s)", (canSend, placeholder) => {
		render(
			<InputBar
				sessionId={TEST_SESSION_ID}
				onSend={sendAccepted}
				canSend={canSend}
				sendBlockedReason="Answer the permission request to send"
			/>,
		);

		expect(screen.getByRole("textbox")).toHaveAttribute(
			"placeholder",
			expect.stringMatching(placeholder),
		);
	});

	it("does not send on Enter when canSend is false", () => {
		const onSend = vi.fn(sendAccepted);
		render(
			<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} canSend={false} />,
		);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Should not send" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		expect(onSend).not.toHaveBeenCalled();
	});

	// An open turn is not a reason to refuse: a message sent mid-reply steers the
	// running turn and is answered inside it, in a bubble opened where the agent
	// reads it rather than the one already being written (docs/lifecycle-ui.md §2.3).
	// The states that *do* refuse reach the bar as `canSend={false}`, decided by
	// the host — the bar itself must not add a second rule on top of it, or it
	// would refuse sends the server would have accepted.
	describe("while a turn is open", () => {
		it("sends, by button and by Enter alike", () => {
			const onSend = vi.fn(sendAccepted);
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} turnOpen />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "also look at X" } });

			expect(screen.getByRole("button", { name: /Send/ })).not.toBeDisabled();
			fireEvent.keyDown(textarea, { key: "Enter" });
			expect(onSend).toHaveBeenCalledWith("also look at X");
		});

		// Enter is the path that matters when the host does refuse: it never goes
		// near the button, so a rule written only on `disabled` is a rule the
		// keyboard does not have.
		it("refuses both ways once the host withdraws canSend", () => {
			const onSend = vi.fn(sendAccepted);
			render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={onSend}
					canSend={false}
					turnOpen
				/>,
			);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, {
				target: { value: "answer the card first" },
			});

			expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
			fireEvent.keyDown(textarea, { key: "Enter" });
			expect(onSend).not.toHaveBeenCalled();
		});

		// Typing is never blocked, only sending — a draft written during the wait
		// has to survive it.
		it("keeps the draft typeable", () => {
			render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					canSend={false}
					turnOpen
				/>,
			);

			const textarea = screen.getByRole("textbox");
			expect(textarea).not.toBeDisabled();
			fireEvent.change(textarea, { target: { value: "written while busy" } });
			expect(textarea).toHaveValue("written while busy");
		});
	});

	it("calls onSend with trimmed input when button clicked", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn(sendAccepted);
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.type(screen.getByRole("textbox"), " Hello World ");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(onSend).toHaveBeenCalledWith("Hello World");
	});

	it("clears input after sending", async () => {
		const user = userEvent.setup();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

		const textarea = screen.getByRole("textbox");
		await user.type(textarea, "Test message");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(textarea).toHaveValue("");
	});

	it("sends on Enter", async () => {
		const onSend = vi.fn(sendAccepted);
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Enter test" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		expect(onSend).toHaveBeenCalledWith("Enter test");
	});

	it("does not send on Shift+Enter (newline)", async () => {
		const onSend = vi.fn(sendAccepted);
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Shift+Enter test" } });
		fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not send on Enter with coarse pointer (touch device)", async () => {
		const { hasCoarsePointer } = await import("@pockode/shared");
		vi.mocked(hasCoarsePointer).mockReturnValue(true);

		const onSend = vi.fn(sendAccepted);
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Touch device test" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		expect(onSend).not.toHaveBeenCalled();

		vi.mocked(hasCoarsePointer).mockReturnValue(false);
	});

	it("does not send empty messages", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn(sendAccepted);
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.click(screen.getByRole("button", { name: /Send/ }));
		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not send whitespace-only messages", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn(sendAccepted);
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.type(screen.getByRole("textbox"), "  ");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(onSend).not.toHaveBeenCalled();
	});

	it("preserves input across re-renders with same sessionId", () => {
		const { rerender } = render(
			<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />,
		);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "preserved text" } });

		rerender(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

		expect(textarea).toHaveValue("preserved text");
	});

	it("maintains separate input state per session", () => {
		const { rerender } = render(
			<InputBar sessionId="session-1" onSend={sendAccepted} />,
		);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "session 1 text" } });

		rerender(<InputBar sessionId="session-2" onSend={sendAccepted} />);
		expect(textarea).toHaveValue("");

		fireEvent.change(textarea, { target: { value: "session 2 text" } });

		rerender(<InputBar sessionId="session-1" onSend={sendAccepted} />);
		expect(textarea).toHaveValue("session 1 text");
	});

	it("saves sent message to history", async () => {
		const user = userEvent.setup();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

		await user.type(screen.getByRole("textbox"), "test message");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
		expect(stored).toContain("test message");
	});

	it("navigates to previous history on ArrowUp when at visual boundary", async () => {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(["previous message"]));
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

		const textarea = screen.getByRole("textbox");

		// Y coordinate stays the same (simulating cursor at visual top boundary)
		mockGetCaretCoordinates.mockReturnValue({ top: 0, left: 0, height: 20 });

		fireEvent.keyDown(textarea, { key: "ArrowUp" });
		fireEvent.keyUp(textarea, { key: "ArrowUp" });

		await waitFor(() => {
			expect(textarea).toHaveValue("previous message");
		});
	});

	it("does not navigate history when cursor moves visually", async () => {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(["previous message"]));
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "multi\nline\ntext" } });

		// Y coordinate changes (simulating cursor moving from line 3 to line 2)
		mockGetCaretCoordinates
			.mockReturnValueOnce({ top: 40, left: 0, height: 20 }) // keydown: line 3
			.mockReturnValueOnce({ top: 20, left: 0, height: 20 }); // keyup: line 2

		fireEvent.keyDown(textarea, { key: "ArrowUp" });
		fireEvent.keyUp(textarea, { key: "ArrowUp" });

		// Should NOT navigate to history because Y changed
		expect(textarea).toHaveValue("multi\nline\ntext");
	});

	it("navigates back to draft on ArrowDown when at visual boundary", async () => {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(["history"]));
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "my draft" } });

		// Navigate up to history (Y stays same = at boundary)
		mockGetCaretCoordinates.mockReturnValue({ top: 0, left: 0, height: 20 });
		fireEvent.keyDown(textarea, { key: "ArrowUp" });
		fireEvent.keyUp(textarea, { key: "ArrowUp" });

		await waitFor(() => {
			expect(textarea).toHaveValue("history");
		});

		// Navigate down back to draft (Y stays same = at boundary)
		fireEvent.keyDown(textarea, { key: "ArrowDown" });
		fireEvent.keyUp(textarea, { key: "ArrowDown" });

		await waitFor(() => {
			expect(textarea).toHaveValue("my draft");
		});
	});

	it("does not open palette when navigating to slash command in history", async () => {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(["/help"]));
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

		const textarea = screen.getByRole("textbox");

		mockGetCaretCoordinates.mockReturnValue({ top: 0, left: 0, height: 20 });
		fireEvent.keyDown(textarea, { key: "ArrowUp" });
		fireEvent.keyUp(textarea, { key: "ArrowUp" });

		await waitFor(() => {
			expect(textarea).toHaveValue("/help");
		});

		// Palette should NOT open for history-navigated slash commands
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	describe("command palette", () => {
		it("opens palette when typing /", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("does not open palette when / is followed by whitespace", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/help " } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("does not open palette for file paths", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/path/to/file" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("does not open palette for dotfiles", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/.env" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("does not open palette for uppercase commands", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/Help" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("opens palette for plugin-namespaced commands", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/plugin:command" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette for underscore commands", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/pr_comments" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette for hyphen commands", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/my-command" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette for commands with numbers", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/cmd123" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette for namespaced commands with hyphen", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, {
				target: { value: "/my-plugin:my-command" },
			});

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("does not open palette for commands starting with number", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/123cmd" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("does not open palette for commands starting with hyphen", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/-cmd" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("filters commands by input", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/mo" } });

			const options = await screen.findAllByRole("option");
			expect(options).toHaveLength(2);
			expect(options[0]).toHaveTextContent("/model");
			expect(options[1]).toHaveTextContent("/memory");
		});

		it("shows (custom) badge for non-builtin commands", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/my" } });

			const option = await screen.findByRole("option");
			expect(option).toHaveTextContent("/my-custom");
			expect(option).toHaveTextContent("(custom)");
		});

		it("navigates with ArrowUp and ArrowDown", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			const options = await screen.findAllByRole("option");
			// Initially first item is selected
			expect(options[0]).toHaveAttribute("aria-selected", "true");

			// ArrowDown selects second item
			fireEvent.keyDown(textarea, { key: "ArrowDown" });
			expect(options[1]).toHaveAttribute("aria-selected", "true");

			// ArrowUp goes back to first
			fireEvent.keyDown(textarea, { key: "ArrowUp" });
			expect(options[0]).toHaveAttribute("aria-selected", "true");
		});

		it("wraps around when navigating past ends", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			const options = await screen.findAllByRole("option");

			// ArrowUp from first item wraps to last
			fireEvent.keyDown(textarea, { key: "ArrowUp" });
			expect(options[options.length - 1]).toHaveAttribute(
				"aria-selected",
				"true",
			);
		});

		it("selects command on Tab or Enter", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await screen.findAllByRole("option");

			// Enter selects the first command
			fireEvent.keyDown(textarea, { key: "Enter" });
			expect(textarea).toHaveValue("/help ");
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

			// Tab also selects
			fireEvent.change(textarea, { target: { value: "/" } });
			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
			fireEvent.keyDown(textarea, { key: "Tab" });
			expect(textarea).toHaveValue("/help ");
		});

		it("selects command on click", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			fireEvent.click(await screen.findByText("/model"));

			expect(textarea).toHaveValue("/model ");
		});

		it("closes palette on Escape without removing /", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/he" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			fireEvent.keyDown(textarea, { key: "Escape" });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
			expect(textarea).toHaveValue("/he");
		});

		// The palette hangs over the composer with no backdrop of its own, so the
		// click that dismisses it carries on to whatever is behind — and the
		// chat's answer panel reads a press on the dimmed transcript as its own
		// dismissal, from `window`. One press, one panel: the palette takes the
		// click it acts on off the path, the way its Escape already does.
		it("claims the outside click it closes on", async () => {
			const onWindowClick = vi.fn();
			window.addEventListener("click", onWindowClick);
			try {
				render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

				const textarea = screen.getByRole("textbox");
				fireEvent.change(textarea, { target: { value: "/he" } });
				await waitFor(() => {
					expect(screen.getByRole("listbox")).toBeInTheDocument();
				});
				// The hook attaches a task after opening, so the click that
				// opened the palette cannot close it again.
				await waitFor(() => {});

				fireEvent.click(document.body);

				expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
				expect(onWindowClick).not.toHaveBeenCalled();
			} finally {
				window.removeEventListener("click", onWindowClick);
			}
		});

		it("reopens palette from the + menu after dismiss", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			fireEvent.keyDown(textarea, { key: "Escape" });
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

			fireEvent.click(screen.getByRole("button", { name: "Add" }));
			fireEvent.click(screen.getByRole("menuitem", { name: "Commands" }));
			expect(textarea).toHaveValue("/");

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("resets dismissed state when / is removed from input", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			fireEvent.keyDown(textarea, { key: "Escape" });
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

			// Remove / and type it again
			fireEvent.change(textarea, { target: { value: "" } });
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette when replacing text with /", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");

			// Type some text first
			fireEvent.change(textarea, { target: { value: "hello world" } });
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

			// Simulate select-all and type "/" (replaces entire text)
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("shows no matching commands message when filter has no results", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/xyz" } });
			await commandsLoaded();

			expect(screen.getByText("No matching commands")).toBeInTheDocument();
		});

		it("resets selection to first when filter changes", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await screen.findAllByRole("option");

			// Navigate to select third item
			fireEvent.keyDown(textarea, { key: "ArrowDown" });
			fireEvent.keyDown(textarea, { key: "ArrowDown" });
			const options = screen.getAllByRole("option");
			expect(options[2]).toHaveAttribute("aria-selected", "true");

			// Change filter - selection should reset to first item
			fireEvent.change(textarea, { target: { value: "/m" } });
			const newOptions = screen.getAllByRole("option");
			expect(newOptions[0]).toHaveAttribute("aria-selected", "true");
		});

		it("handles empty commands list gracefully", async () => {
			mockListCommands.mockResolvedValue([]);
			const onSend = vi.fn(sendAccepted);
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });
			await commandsLoaded();

			expect(screen.getByText("No matching commands")).toBeInTheDocument();

			// ArrowDown should not crash with empty list
			fireEvent.keyDown(textarea, { key: "ArrowDown" });

			// With empty list, palette stays open and ArrowDown does nothing
			expect(screen.getByRole("listbox")).toBeInTheDocument();

			// Enter with empty list falls through to normal send behavior
			fireEvent.keyDown(textarea, { key: "Enter" });
			expect(onSend).toHaveBeenCalledWith("/");
		});

		it("does not trigger history navigation when palette is open", async () => {
			localStorage.setItem(HISTORY_KEY, JSON.stringify(["previous message"]));
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			const options = await screen.findAllByRole("option");

			// ArrowUp should navigate palette, not history. History moves on
			// keyup, so the release has to be sent for this to test anything.
			fireEvent.keyDown(textarea, { key: "ArrowUp" });
			fireEvent.keyUp(textarea, { key: "ArrowUp" });

			// Input should still be "/" (not "previous message" from history)
			expect(textarea).toHaveValue("/");
			expect(options[options.length - 1]).toHaveAttribute(
				"aria-selected",
				"true",
			);
		});
	});

	// Autofocus follows the pointer, not the width: what makes it welcome is a
	// physical keyboard, and a mini pad has a wide viewport without one — the
	// on-screen keyboard used to eat half the conversation the moment it opened.
	describe("autofocus", () => {
		it("focuses the input when the primary pointer is fine", () => {
			vi.mocked(useHasCoarsePointer).mockReturnValue(false);
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			expect(screen.getByRole("textbox")).toHaveFocus();
		});

		it("leaves the input alone when the primary pointer is coarse", () => {
			vi.mocked(useHasCoarsePointer).mockReturnValue(true);
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			expect(screen.getByRole("textbox")).not.toHaveFocus();
		});

		// A draft put back after signing in: the host asks, and the bar answers
		// the way it answers a session change.
		it.each([
			[false, true],
			[true, false],
		])("answers a focus request when coarse is %s: focused %s", (coarse, focused) => {
			vi.mocked(useHasCoarsePointer).mockReturnValue(coarse);
			const { rerender } = render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					focusRequest={0}
				/>,
			);
			screen.getByRole("textbox").blur();

			rerender(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					focusRequest={1}
				/>,
			);

			if (focused) expect(screen.getByRole("textbox")).toHaveFocus();
			else expect(screen.getByRole("textbox")).not.toHaveFocus();
		});
	});

	// One slot, Send or Stop, never both: a destructive target beside Send under
	// a thumb is what it rules out. Stop has the slot whenever an open turn
	// leaves Send nothing to do.
	describe("send / stop slot", () => {
		const send = () => screen.queryByRole("button", { name: "Send" });
		const stop = () => screen.queryByRole("button", { name: "Stop" });

		afterEach(() => resetChatUIConfig());

		it.each<[string, Partial<Parameters<typeof InputBar>[0]>, string, string]>([
			["idle, no draft", {}, "", "send-disabled"],
			["idle, a draft", {}, "hi", "send"],
			["open turn, no draft", { turnOpen: true }, "", "stop"],
			["open turn, a draft", { turnOpen: true }, "steer", "send"],
			[
				"open turn the host refuses sends in, a draft",
				{ turnOpen: true, canSend: false },
				"never mind",
				"stop",
			],
			[
				"switching sessions",
				{ turnOpen: true, disabled: true },
				"",
				"send-disabled",
			],
		])("%s", (_label, props, draft, expected) => {
			useInputStore.setState({ inputs: { [TEST_SESSION_ID]: draft } });
			render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					onStop={() => {}}
					{...props}
				/>,
			);

			if (expected === "stop") {
				expect(stop()).toBeInTheDocument();
				expect(send()).not.toBeInTheDocument();
			} else {
				expect(stop()).not.toBeInTheDocument();
				if (expected === "send") expect(send()).toBeEnabled();
				else expect(send()).toBeDisabled();
			}
		});

		// Sending empties the draft and opens the turn in one go, so the Stop
		// that replaces Send lands under the thumb that just pressed it — on
		// every change from Send to Stop, not only the first.
		it("holds Stop unpressable for a moment each time it takes the slot", () => {
			vi.useFakeTimers();
			try {
				useInputStore.setState({ inputs: { [TEST_SESSION_ID]: "steer" } });
				render(
					<InputBar
						sessionId={TEST_SESSION_ID}
						onSend={sendAccepted}
						onStop={() => {}}
						turnOpen
					/>,
				);
				const armed = () => stop()?.closest("[inert]") === null;

				for (const round of [1, 2]) {
					act(() =>
						useInputStore.setState({ inputs: { [TEST_SESSION_ID]: "" } }),
					);
					expect(armed(), `round ${round}, on arrival`).toBe(false);
					act(() => vi.advanceTimersByTime(ARM_MS));
					expect(armed(), `round ${round}, after the wait`).toBe(true);

					act(() =>
						useInputStore.setState({
							inputs: { [TEST_SESSION_ID]: "steer" },
						}),
					);
					expect(stop()).not.toBeInTheDocument();
				}
			} finally {
				vi.useRealTimers();
			}
		});

		// Stop unmounts the Send that had focus; focus must not drop to <body>.
		it("hands focus to the draft when Send gives way to Stop", async () => {
			const user = userEvent.setup();
			const { rerender } = render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					onStop={() => {}}
				/>,
			);
			await user.type(screen.getByRole("textbox"), "go");
			await user.click(screen.getByRole("button", { name: "Send" }));
			rerender(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					onStop={() => {}}
					turnOpen
				/>,
			);

			expect(stop()).toBeInTheDocument();
			expect(screen.getByRole("textbox")).toHaveFocus();
		});

		// The swap the user did not cause: a turn ending under a focused Stop.
		it("hands focus to the draft when Stop gives way to Send", async () => {
			const { rerender } = render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					onStop={() => {}}
					turnOpen
				/>,
			);
			await waitFor(() => expect(stop()?.closest("[inert]")).toBeNull());
			act(() => stop()?.focus());
			rerender(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					onStop={() => {}}
				/>,
			);

			expect(stop()).not.toBeInTheDocument();
			expect(screen.getByRole("textbox")).toHaveFocus();
		});

		it("draws a registered StopButton in the slot", () => {
			setChatUIConfig({
				StopButton: ({ onStop }) => (
					<button type="button" onClick={onStop}>
						Halt
					</button>
				),
			});
			render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					onStop={() => {}}
					turnOpen
				/>,
			);

			expect(screen.getByRole("button", { name: "Halt" })).toBeInTheDocument();
			expect(stop()).not.toBeInTheDocument();
		});

		it("keeps Send in the slot when StopButton is null", () => {
			setChatUIConfig({ StopButton: null });
			render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					onStop={() => {}}
					turnOpen
				/>,
			);

			expect(stop()).not.toBeInTheDocument();
			expect(send()).toBeDisabled();
		});
	});

	describe("+ menu", () => {
		const add = () => screen.getByRole("button", { name: "Add" });
		const menu = () => screen.queryByRole("menu");

		it("opens Commands as the palette, starting the draft with /", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);
			await user.type(screen.getByRole("textbox"), "explain");

			await user.click(add());
			expect(add()).toHaveAttribute("aria-expanded", "true");
			await user.click(screen.getByRole("menuitem", { name: "Commands" }));

			expect(menu()).not.toBeInTheDocument();
			expect(screen.getByRole("textbox")).toHaveValue("/explain");
			expect(screen.getByRole("listbox")).toBeInTheDocument();
			expect(screen.getByRole("textbox")).toHaveFocus();
		});

		// Pressing `+` must not take the caret out of the draft: on a phone that
		// drops the on-screen keyboard.
		it("leaves focus in the draft when pressed", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);
			expect(screen.getByRole("textbox")).toHaveFocus();

			await user.click(add());

			expect(menu()).toBeInTheDocument();
			expect(screen.getByRole("textbox")).toHaveFocus();
		});

		it("moves focus into the menu when opened from the keyboard", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			add().focus();
			await user.keyboard("{Enter}");

			expect(screen.getByRole("menuitem", { name: "Commands" })).toHaveFocus();
		});

		it("walks into the menu from the draft with the arrow keys", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);
			await user.click(add());

			await user.keyboard("{ArrowDown}");

			expect(screen.getByRole("menuitem", { name: "Commands" })).toHaveFocus();
		});

		it("leaves by Tab to the draft, and by Shift+Tab to the +", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			add().focus();
			await user.keyboard("{Enter}");
			await user.tab();
			expect(menu()).not.toBeInTheDocument();
			expect(screen.getByRole("textbox")).toHaveFocus();

			add().focus();
			await user.keyboard("{Enter}");
			await user.tab({ shift: true });
			expect(menu()).not.toBeInTheDocument();
			expect(add()).toHaveFocus();
		});

		it("closes when the session changes under it", async () => {
			const user = userEvent.setup();
			const { rerender } = render(
				<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />,
			);
			await user.click(add());

			rerender(<InputBar sessionId="another" onSend={sendAccepted} />);

			expect(menu()).not.toBeInTheDocument();
		});

		// It counts as covering the page and marks the key, so neither the chat's
		// interrupt nor the answer panel acts on the same press.
		// What keeps the chat's Escape-to-interrupt off the press that closes it.
		it("covers the page while it is open", async () => {
			const user = userEvent.setup();
			function CoverProbe() {
				return <output>{useIsPageCovered() ? "covered" : "clear"}</output>;
			}
			render(
				<>
					<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />
					<CoverProbe />
				</>,
			);
			expect(screen.getByRole("status")).toHaveTextContent("clear");

			await user.click(add());
			expect(screen.getByRole("status")).toHaveTextContent("covered");

			await user.click(add());
			expect(screen.getByRole("status")).toHaveTextContent("clear");
		});

		it("claims the Escape it closes on", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);
			await user.click(add());

			const press = new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			});
			act(() => {
				document.dispatchEvent(press);
			});

			expect(press.defaultPrevented).toBe(true);
			expect(menu()).not.toBeInTheDocument();
			expect(screen.getByRole("textbox")).toHaveFocus();
		});

		it("claims the outside click it closes on", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);
			fireEvent.click(add());
			expect(menu()).toBeInTheDocument();
			// The hook attaches a task after opening.
			await waitFor(() => {});

			// Listening only from here: the press that opened the menu was
			// not a dismissal and is nobody's to claim.
			const onWindowClick = vi.fn();
			window.addEventListener("click", onWindowClick);
			try {
				fireEvent.click(document.body);

				expect(menu()).not.toBeInTheDocument();
				expect(onWindowClick).not.toHaveBeenCalled();
			} finally {
				window.removeEventListener("click", onWindowClick);
			}
		});

		// Both hang from the same place, so only one is up at a time.
		it("takes turns with the palette", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);
			const textarea = screen.getByRole("textbox");

			fireEvent.change(textarea, { target: { value: "/" } });
			expect(screen.getByRole("listbox")).toBeInTheDocument();
			fireEvent.click(add());
			expect(menu()).toBeInTheDocument();
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

			fireEvent.change(textarea, { target: { value: "" } });
			fireEvent.change(textarea, { target: { value: "/" } });
			expect(screen.getByRole("listbox")).toBeInTheDocument();
			expect(menu()).not.toBeInTheDocument();
			await commandsLoaded();
		});
	});

	describe("attachments", () => {
		const uploaded: ChatAttachment = {
			id: "a1.png",
			name: "shot.png",
			size: 4,
			mime: "image/png",
		};
		const png = () => new File(["abcd"], "shot.png", { type: "image/png" });

		function deferredUpload() {
			let resolve: (value: ChatAttachment) => void = () => {};
			let reject: (error: Error) => void = () => {};
			vi.mocked(uploadChatAttachment).mockImplementationOnce(
				() =>
					new Promise((res, rej) => {
						resolve = res;
						reject = rej;
					}),
			);
			return {
				resolve: (v = uploaded) => resolve(v),
				reject: (e: Error) => reject(e),
			};
		}

		beforeEach(() => {
			URL.createObjectURL = vi.fn(() => "blob:preview");
			URL.revokeObjectURL = vi.fn();
		});

		it("opens the photo library from Photos and any file from Files", async () => {
			const user = userEvent.setup();
			const click = vi.spyOn(HTMLInputElement.prototype, "click");
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			await user.click(screen.getByRole("button", { name: "Add" }));
			await user.click(screen.getByRole("menuitem", { name: "Photos" }));
			expect(click.mock.contexts.at(-1)).toBe(
				screen.getByTestId("photo-input"),
			);
			expect(screen.getByTestId("photo-input")).toHaveAttribute(
				"accept",
				"image/*",
			);

			await user.click(screen.getByRole("button", { name: "Add" }));
			await user.click(screen.getByRole("menuitem", { name: "Files" }));
			expect(click.mock.contexts.at(-1)).toBe(screen.getByTestId("file-input"));
			click.mockRestore();
		});

		it("previews a picked file, holds Send while it uploads, then sends it with no text", async () => {
			const user = userEvent.setup();
			const upload = deferredUpload();
			const onSend = vi.fn(sendAccepted);
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

			await user.upload(screen.getByTestId("photo-input"), png());

			expect(screen.getByRole("img", { name: "shot.png" })).toHaveAttribute(
				"src",
				"blob:preview",
			);
			expect(
				screen.getByRole("status", { name: "Uploading shot.png" }),
			).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

			await act(async () => upload.resolve());
			await user.click(screen.getByRole("button", { name: "Send" }));

			expect(onSend).toHaveBeenCalledWith("", [uploaded]);
			expect(
				screen.queryByRole("list", { name: "Attachments" }),
			).not.toBeInTheDocument();
			await waitFor(() =>
				expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview"),
			);
		});

		it("removes a picked file", async () => {
			const user = userEvent.setup();
			deferredUpload();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);
			await user.upload(screen.getByTestId("file-input"), png());

			await user.click(screen.getByRole("button", { name: "Remove shot.png" }));

			expect(
				screen.queryByRole("list", { name: "Attachments" }),
			).not.toBeInTheDocument();
			const { signal } = vi.mocked(uploadChatAttachment).mock.calls[0][0];
			expect(signal?.aborted).toBe(true);
			expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
			expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		});

		// Sending without it would leave a file the user picked quietly behind.
		it("says why an upload failed and holds Send until the file is removed", async () => {
			const user = userEvent.setup();
			const upload = deferredUpload();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);
			await user.type(screen.getByRole("textbox"), "look");
			await user.upload(screen.getByTestId("file-input"), png());

			await act(async () => upload.reject(new Error("Session not found")));

			expect(screen.getByText("Session not found")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

			await user.click(screen.getByRole("button", { name: "Remove shot.png" }));
			expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
		});

		// A file Send cannot take is no reason to keep Stop off the slot — not
		// even with text beside it: the turn would have no way to be
		// interrupted on a touch screen.
		it("leaves Stop in the slot while a file cannot be sent", async () => {
			const user = userEvent.setup();
			const upload = deferredUpload();
			render(
				<InputBar
					sessionId={TEST_SESSION_ID}
					onSend={sendAccepted}
					turnOpen
					onStop={vi.fn()}
				/>,
			);
			await user.upload(screen.getByTestId("photo-input"), png());
			expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

			await act(async () => upload.reject(new Error("Session not found")));
			expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

			await user.type(screen.getByRole("textbox"), "and this");
			expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
		});

		it("refuses a file over the server's ceiling without uploading it", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			await user.upload(
				screen.getByTestId("file-input"),
				new File(["x".repeat(2048)], "big.pdf", { type: "application/pdf" }),
			);

			expect(uploadChatAttachment).not.toHaveBeenCalled();
			expect(screen.getByText("Too large (max 1 KB)")).toBeInTheDocument();
		});

		it("gives the files back when the message is refused", async () => {
			const user = userEvent.setup();
			const upload = deferredUpload();
			const onSend = vi.fn(async (): Promise<SendOutcome> => "refused");
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);
			await user.upload(screen.getByTestId("photo-input"), png());
			await act(async () => upload.resolve());

			await user.click(screen.getByRole("button", { name: "Send" }));

			expect(onSend).toHaveBeenCalled();
			expect(
				await screen.findByRole("img", { name: "shot.png" }),
			).toBeInTheDocument();
			expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		});

		// The bar is unmounted whenever the host needs its row; a file still
		// uploading has to be there when it comes back.
		it("keeps the files across the bar unmounting", async () => {
			const user = userEvent.setup();
			const upload = deferredUpload();
			const { unmount } = render(
				<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />,
			);
			await user.upload(screen.getByTestId("photo-input"), png());
			unmount();
			await act(async () => upload.resolve());

			render(<InputBar sessionId={TEST_SESSION_ID} onSend={sendAccepted} />);

			expect(screen.getByRole("img", { name: "shot.png" })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
		});
	});
});
