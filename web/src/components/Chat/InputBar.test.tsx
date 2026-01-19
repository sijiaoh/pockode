import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInputStore } from "../../lib/inputStore";
import InputBar from "./InputBar";

vi.mock("../../utils/breakpoints", () => ({
	isMobile: vi.fn(() => false),
	hasCoarsePointer: vi.fn(() => false),
}));

const mockListCommands = vi.fn();
const mockInvalidateCommandCache = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) =>
		selector({
			actions: {
				listCommands: mockListCommands,
				invalidateCommandCache: mockInvalidateCommandCache,
			},
		}),
	),
}));

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();

const HISTORY_KEY = "input_history";

const TEST_SESSION_ID = "test-session";

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
		mockInvalidateCommandCache.mockClear();
	});

	afterEach(() => {
		useInputStore.setState({ inputs: {} });
		localStorage.clear();
		vi.clearAllMocks();
	});

	it("disables send button when canSend is false", () => {
		render(
			<InputBar
				sessionId={TEST_SESSION_ID}
				onSend={() => {}}
				canSend={false}
			/>,
		);

		expect(screen.getByRole("textbox")).not.toBeDisabled();
		expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
	});

	it("does not send on Enter when canSend is false", () => {
		const onSend = vi.fn();
		render(
			<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} canSend={false} />,
		);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Should not send" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		expect(onSend).not.toHaveBeenCalled();
	});

	it("calls onSend with trimmed input when button clicked", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.type(screen.getByRole("textbox"), "  Hello World  ");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(onSend).toHaveBeenCalledWith("Hello World");
	});

	it("clears input after sending", async () => {
		const user = userEvent.setup();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

		const textarea = screen.getByRole("textbox");
		await user.type(textarea, "Test message");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(textarea).toHaveValue("");
	});

	it("sends on Enter", async () => {
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Enter test" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		expect(onSend).toHaveBeenCalledWith("Enter test");
	});

	it("does not send on Shift+Enter (newline)", async () => {
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Shift+Enter test" } });
		fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not send on Enter with coarse pointer (touch device)", async () => {
		const { hasCoarsePointer } = await import("../../utils/breakpoints");
		vi.mocked(hasCoarsePointer).mockReturnValue(true);

		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Touch device test" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		expect(onSend).not.toHaveBeenCalled();

		vi.mocked(hasCoarsePointer).mockReturnValue(false);
	});

	it("does not send empty messages", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.click(screen.getByRole("button", { name: /Send/ }));
		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not send whitespace-only messages", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.type(screen.getByRole("textbox"), "   ");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(onSend).not.toHaveBeenCalled();
	});

	it("shows Stop button when streaming", () => {
		render(
			<InputBar
				sessionId={TEST_SESSION_ID}
				onSend={() => {}}
				isStreaming
				onInterrupt={() => {}}
			/>,
		);

		expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Send/ }),
		).not.toBeInTheDocument();
	});

	it("calls onInterrupt when Stop button clicked", async () => {
		const user = userEvent.setup();
		const onInterrupt = vi.fn();
		render(
			<InputBar
				sessionId={TEST_SESSION_ID}
				onSend={() => {}}
				isStreaming
				onInterrupt={onInterrupt}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /Stop/ }));

		expect(onInterrupt).toHaveBeenCalled();
	});

	it("preserves input across re-renders with same sessionId", () => {
		const { rerender } = render(
			<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />,
		);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "preserved text" } });

		rerender(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

		expect(textarea).toHaveValue("preserved text");
	});

	it("maintains separate input state per session", () => {
		const { rerender } = render(
			<InputBar sessionId="session-1" onSend={() => {}} />,
		);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "session 1 text" } });

		rerender(<InputBar sessionId="session-2" onSend={() => {}} />);
		expect(textarea).toHaveValue("");

		fireEvent.change(textarea, { target: { value: "session 2 text" } });

		rerender(<InputBar sessionId="session-1" onSend={() => {}} />);
		expect(textarea).toHaveValue("session 1 text");
	});

	it("saves sent message to history", async () => {
		const user = userEvent.setup();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

		await user.type(screen.getByRole("textbox"), "test message");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
		expect(stored).toContain("test message");
	});

	it("navigates to previous history on ArrowUp", () => {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(["previous message"]));
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.keyDown(textarea, { key: "ArrowUp" });

		expect(textarea).toHaveValue("previous message");
	});

	it("navigates back to draft on ArrowDown", () => {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(["history"]));
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "my draft" } });
		fireEvent.keyDown(textarea, { key: "ArrowUp" });

		expect(textarea).toHaveValue("history");

		fireEvent.keyDown(textarea, { key: "ArrowDown" });

		expect(textarea).toHaveValue("my draft");
	});

	describe("command palette", () => {
		it("opens palette when typing /", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("does not open palette when / is followed by whitespace", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/help " } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("does not open palette for file paths", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/path/to/file" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("does not open palette for dotfiles", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/.env" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("does not open palette for uppercase commands", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/Help" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("opens palette for plugin-namespaced commands", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/plugin:command" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette for underscore commands", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/pr_comments" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette for hyphen commands", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/my-command" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette for commands with numbers", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/cmd123" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("opens palette for namespaced commands with hyphen", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, {
				target: { value: "/my-plugin:my-command" },
			});

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("does not open palette for commands starting with number", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/123cmd" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("does not open palette for commands starting with hyphen", () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/-cmd" } });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		});

		it("filters commands by input", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/mo" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			const options = screen.getAllByRole("option");
			expect(options).toHaveLength(2);
			expect(options[0]).toHaveTextContent("/model");
			expect(options[1]).toHaveTextContent("/memory");
		});

		it("shows (custom) badge for non-builtin commands", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/my" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			const option = screen.getByRole("option");
			expect(option).toHaveTextContent("/my-custom");
			expect(option).toHaveTextContent("(custom)");
		});

		it("navigates with ArrowUp and ArrowDown", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			const options = screen.getAllByRole("option");
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
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			const options = screen.getAllByRole("option");

			// ArrowUp from first item wraps to last
			fireEvent.keyDown(textarea, { key: "ArrowUp" });
			expect(options[options.length - 1]).toHaveAttribute(
				"aria-selected",
				"true",
			);
		});

		it("selects command on Tab or Enter", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

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
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText("/model"));

			expect(textarea).toHaveValue("/model ");
		});

		it("closes palette on Escape without removing /", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/he" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			fireEvent.keyDown(textarea, { key: "Escape" });

			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
			expect(textarea).toHaveValue("/he");
		});

		it("reopens palette when clicking trigger button after dismiss", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			fireEvent.keyDown(textarea, { key: "Escape" });
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

			fireEvent.click(screen.getByLabelText("Toggle commands"));

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});
		});

		it("resets dismissed state when / is removed from input", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

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
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

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
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/xyz" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			expect(screen.getByText("No matching commands")).toBeInTheDocument();
		});

		it("invalidates command cache when slash command is sent", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			await user.type(screen.getByRole("textbox"), "/help");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			expect(mockInvalidateCommandCache).toHaveBeenCalled();
		});

		it("does not invalidate cache when regular message is sent", async () => {
			const user = userEvent.setup();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			await user.type(screen.getByRole("textbox"), "hello");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			expect(mockInvalidateCommandCache).not.toHaveBeenCalled();
		});

		it("resets selection to first when filter changes", async () => {
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

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
			const onSend = vi.fn();
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

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
			render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

			const textarea = screen.getByRole("textbox");
			fireEvent.change(textarea, { target: { value: "/" } });

			await waitFor(() => {
				expect(screen.getByRole("listbox")).toBeInTheDocument();
			});

			// ArrowUp should navigate palette, not history
			fireEvent.keyDown(textarea, { key: "ArrowUp" });

			// Input should still be "/" (not "previous message" from history)
			expect(textarea).toHaveValue("/");
		});
	});
});
