import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Message } from "../../types/message";
import MessageItem from "./MessageItem";

const mockWorkDir = vi.hoisted(() => ({ value: "/Users/test/project" }));

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { workDir: string }) => string) =>
		selector({ workDir: mockWorkDir.value }),
}));

describe("MessageItem", () => {
	it("renders user message content", () => {
		const message: Message = {
			id: "1",
			role: "user",
			content: "Hello AI",
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Hello AI")).toBeInTheDocument();
	});

	describe("work event", () => {
		const systemMessage = (
			overrides: Partial<Extract<Message, { role: "user" }>> = {},
		): Message => ({
			id: "sm-1",
			role: "user",
			content: "## Current Step\nStep 1 of 3\n\nDo the thing",
			status: "complete",
			createdAt: new Date(),
			source: "system",
			subtype: "kickoff",
			meta: { title: "My work" },
			...overrides,
		});

		it("renders a collapsed line with the action and its title", () => {
			render(<MessageItem sessionId="session-1" message={systemMessage()} />);
			expect(screen.getByText("Pockode · Started")).toBeInTheDocument();
			expect(screen.getByText("My work")).toBeInTheDocument();
			// Prompt body hidden while collapsed
			expect(screen.queryByText(/Do the thing/)).not.toBeInTheDocument();
			expect(screen.getByRole("button")).toHaveAttribute(
				"aria-expanded",
				"false",
			);
		});

		it("expands to reveal the full prompt on click", async () => {
			const user = userEvent.setup();
			render(<MessageItem sessionId="session-1" message={systemMessage()} />);
			await user.click(screen.getByRole("button"));
			expect(screen.getByText(/Do the thing/)).toBeInTheDocument();
			expect(screen.getByRole("button")).toHaveAttribute(
				"aria-expanded",
				"true",
			);
		});

		it("makes the step itself the action for step_advance", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({
						subtype: "step_advance",
						meta: { title: "My work", step: { current: 2, total: 3 } },
					})}
				/>,
			);
			expect(screen.getByText("Pockode · Step 2/3")).toBeInTheDocument();
		});

		it("offers Details into the work it happened to", async () => {
			const user = userEvent.setup();
			const onOpenWorkDetail = vi.fn();
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({
						meta: { title: "My work", work_id: "work-1" },
					})}
					onOpenWorkDetail={onOpenWorkDetail}
				/>,
			);

			await user.click(screen.getByRole("button", { expanded: false }));
			await user.click(screen.getByRole("button", { name: "Details" }));
			expect(onOpenWorkDetail).toHaveBeenCalledWith("work-1");
		});

		// History recorded before work_id was sent: it still renders, it just has
		// nowhere to link to.
		it("omits Details when the message names no work", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage()}
					onOpenWorkDetail={vi.fn()}
				/>,
			);

			await user.click(screen.getByRole("button", { expanded: false }));
			expect(
				screen.queryByRole("button", { name: "Details" }),
			).not.toBeInTheDocument();
		});

		it("falls back to a generic label for unknown subtypes", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({
						subtype: "future_subtype",
						meta: undefined,
					})}
				/>,
			);
			expect(screen.getByText("Pockode · System Message")).toBeInTheDocument();
		});

		it("does not render a system message as a plain user bubble", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({ content: "raw prompt" })}
				/>,
			);
			// The collapsed line keeps the prompt hidden; a user bubble would show it.
			expect(screen.queryByText("raw prompt")).not.toBeInTheDocument();
		});
	});

	it("renders assistant message with text parts", () => {
		const message: Message = {
			id: "2",
			role: "assistant",
			parts: [{ type: "text", content: "Hello human" }],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Hello human")).toBeInTheDocument();
	});

	it("shows spinner for sending status", () => {
		const message: Message = {
			id: "3",
			role: "assistant",
			parts: [],
			status: "sending",
			createdAt: new Date(),
		};

		// A bubble waiting for the server to take it always spins, wherever it sits.
		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("shows spinner for the last streaming message", () => {
		const message: Message = {
			id: "3",
			role: "assistant",
			parts: [],
			status: "streaming",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} isLast />);
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("shows no indicator for streaming message that is no longer last", () => {
		const message: Message = {
			id: "3",
			role: "assistant",
			parts: [{ type: "text", content: "Previous response" }],
			status: "streaming",
			createdAt: new Date(),
		};

		// When a new message is added, the previous streaming message becomes !isLast
		// In this case, no indicator is shown - the message content stands on its own
		render(
			<MessageItem sessionId="session-1" message={message} isLast={false} />,
		);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByText("Process ended")).not.toBeInTheDocument();
	});

	it("shows error message for error status", () => {
		const message: Message = {
			id: "4",
			role: "assistant",
			parts: [],
			status: "error",
			error: "Connection failed",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Connection failed")).toBeInTheDocument();
	});

	it("shows interrupted indicator for interrupted status", () => {
		const message: Message = {
			id: "4b",
			role: "assistant",
			parts: [{ type: "text", content: "Partial response" }],
			status: "interrupted",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Interrupted")).toBeInTheDocument();
	});

	it("renders tool calls in parts", () => {
		const message: Message = {
			id: "5",
			role: "assistant",
			parts: [
				{ type: "text", content: "I'll read the file" },
				{
					type: "tool_call",
					tool: {
						id: "tool-1",
						name: "Read",
						input: { file: "test.go" },
						status: "success",
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Read")).toBeInTheDocument();
	});

	it("renders tool call with result when expanded", async () => {
		const user = userEvent.setup();
		const message: Message = {
			id: "6",
			role: "assistant",
			parts: [
				{
					type: "tool_call",
					tool: {
						id: "tool-2",
						name: "Bash",
						input: { command: "ls" },
						status: "success",
						result: "file1.txt\nfile2.txt",
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Bash")).toBeInTheDocument();

		// Result is hidden by default (collapsed)
		expect(screen.queryByText(/file1\.txt/)).not.toBeInTheDocument();

		// Click to expand
		await user.click(screen.getByRole("button"));
		expect(screen.getByText(/file1\.txt/)).toBeInTheDocument();
		expect(screen.getByText(/file2\.txt/)).toBeInTheDocument();
	});

	it("shows a file a tool returned without asking to expand anything", async () => {
		const user = userEvent.setup();
		const message: Message = {
			id: "6b",
			role: "assistant",
			parts: [
				{
					type: "tool_call",
					tool: {
						id: "tool-2b",
						name: "Read",
						input: { file_path: "/Users/test/project/doc.pdf" },
						status: "success",
						// claude's block names no file — it hands over the bytes
						// alone — so the name under the entry is the one the call
						// itself read, which is what makes this entry say as much
						// as codex's does for the same file.
						contents: [
							{
								type: "file",
								file: {
									mime: "application/pdf",
									size: 385,
									omitted: "binary",
								},
							},
						],
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);

		// Visible without expanding: the file is the answer, and an answer folded
		// behind a chevron has not been shown. Found by its tooltip, which is the
		// entry's own — the header line above it shows the same short name.
		const entry = screen.getByTitle("/Users/test/project/doc.pdf");
		expect(entry).toHaveTextContent("doc.pdf");
		expect(screen.getByText("Can't be previewed")).toBeInTheDocument();

		// Nothing left to expand, so the header does not pretend there is.
		await user.click(screen.getByText("Read"));
		expect(screen.getByText("Can't be previewed")).toBeInTheDocument();
	});

	it("renders the tools a search returned as names", async () => {
		const user = userEvent.setup();
		const message: Message = {
			id: "6c",
			role: "assistant",
			parts: [
				{
					type: "tool_call",
					tool: {
						id: "tool-2c",
						name: "ToolSearch",
						input: { query: "notebook" },
						status: "success",
						contents: [
							{ type: "tool_reference", toolName: "NotebookEdit" },
							{ type: "tool_reference", toolName: "Read" },
						],
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.queryByText("NotebookEdit")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button"));
		expect(screen.getByText("NotebookEdit")).toBeInTheDocument();
		expect(screen.getByText("Read")).toBeInTheDocument();
	});

	it("renders pending permission_request with action buttons", () => {
		const message: Message = {
			id: "7",
			role: "assistant",
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName: "Bash",
						toolInput: { command: "rm -rf /" },
						toolUseId: "tool-1",
					},
					status: "pending",
				},
			],
			status: "streaming",
			createdAt: new Date(),
		};

		render(
			<MessageItem
				sessionId="session-1"
				message={message}
				onPermissionRespond={vi.fn()}
			/>,
		);
		expect(screen.getByText("Bash")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
	});

	it("calls onPermissionRespond when Allow is clicked", async () => {
		const user = userEvent.setup();
		const onRespond = vi.fn();
		const message: Message = {
			id: "8",
			role: "assistant",
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName: "Bash",
						toolInput: { command: "ls" },
						toolUseId: "tool-1",
					},
					status: "pending",
				},
			],
			status: "streaming",
			createdAt: new Date(),
		};

		render(
			<MessageItem
				sessionId="session-1"
				message={message}
				onPermissionRespond={onRespond}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Allow" }));
		expect(onRespond).toHaveBeenCalledWith(
			{
				requestId: "req-1",
				toolName: "Bash",
				toolInput: { command: "ls" },
				toolUseId: "tool-1",
			},
			"allow",
		);
	});

	it("renders allowed permission_request without buttons", () => {
		const message: Message = {
			id: "9",
			role: "assistant",
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName: "Bash",
						toolInput: { command: "ls" },
						toolUseId: "tool-1",
					},
					status: "allowed",
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Bash")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Allow" }),
		).not.toBeInTheDocument();
	});

	it("renders system message with subtype and status from JSON content", () => {
		const message: Message = {
			id: "10",
			role: "assistant",
			parts: [
				{
					type: "system",
					content:
						'{"type":"system","subtype":"compacting","status":"started"}',
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("compacting: started")).toBeInTheDocument();
	});

	it("renders system message with subtype only when no status", () => {
		const message: Message = {
			id: "11",
			role: "assistant",
			parts: [
				{
					type: "system",
					content: '{"type":"system","subtype":"init"}',
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("init")).toBeInTheDocument();
	});

	// The slot beside the bubble, and the `…` in it. Queried by class because
	// what these assert is geometry, and jsdom applies no Tailwind — the same
	// reason tests/touchTarget.ts reads the source rather than the layout.
	// By size, not by alignment: what these assert is that the 36px slot is there
	// and unchanging, and where it sits in the row is not their claim. `div`
	// because the glyph inside the slot is 36px too (`iconButtonClass`), and a
	// bare `.size-9` would count the slot twice wherever one is drawn.
	describe("message menu slot", () => {
		const slots = (container: HTMLElement) =>
			Array.from(container.querySelectorAll("div.size-9"));

		const settled = (): AssistantMessage => ({
			id: "slot-1",
			role: "assistant",
			parts: [{ type: "text", content: "Answer" }],
			status: "complete",
			createdAt: new Date(),
			anchorSeq: 4,
		});

		const pendingRequest = () => ({
			type: "permission_request" as const,
			request: {
				requestId: "r1",
				toolName: "Bash",
				toolInput: {},
				toolUseId: "t1",
			},
			status: "pending" as const,
		});

		const openFork = async (user: ReturnType<typeof userEvent.setup>) => {
			await user.click(
				screen.getByRole("button", { name: "Actions for the agent's message" }),
			);
			return screen.getByRole("button", { name: /Fork from here/ });
		};

		// The whole point of reserving the slot: the bubble the user is reading
		// does not move when the agent finishes writing into it.
		it("reserves the same slot while streaming and once settled", () => {
			const streaming = render(
				<MessageItem
					sessionId="session-1"
					message={{ ...settled(), status: "streaming" }}
					onForkMessage={vi.fn()}
				/>,
			);
			const before = slots(streaming.container);
			expect(before).toHaveLength(1);
			// Nothing in it yet: a message still being written is not a turn.
			expect(
				screen.queryByRole("button", { name: /^Actions for/ }),
			).not.toBeInTheDocument();

			const after = render(
				<MessageItem
					sessionId="session-1"
					message={settled()}
					onForkMessage={vi.fn()}
				/>,
			);
			const settledSlots = slots(after.container);
			expect(settledSlots).toHaveLength(1);
			expect(settledSlots[0].className).toBe(before[0].className);
			expect(
				screen.getByRole("button", { name: "Actions for the agent's message" }),
			).toBeInTheDocument();
		});

		// A full-bleed line has no bubble to be narrower than, so without a slot
		// of its own it would overhang every bubble in the transcript.
		it("reserves the slot on a work event line too, with nothing in it", () => {
			const { container } = render(
				<MessageItem
					sessionId="session-1"
					message={{
						id: "slot-2",
						role: "user",
						content: "Started",
						status: "complete",
						createdAt: new Date(),
						source: "system",
						subtype: "kickoff",
						meta: { title: "My work" },
					}}
					onForkMessage={vi.fn()}
				/>,
			);
			expect(slots(container)).toHaveLength(1);
			expect(
				screen.queryByRole("button", { name: /^Actions for/ }),
			).not.toBeInTheDocument();
		});

		// Session-level: nothing can be done to any message here, so the room is
		// not paid for either.
		it("reserves nothing when the session cannot fork", () => {
			const { container } = render(
				<MessageItem sessionId="session-1" message={settled()} />,
			);
			expect(slots(container)).toHaveLength(0);
			expect(
				screen.queryByRole("button", { name: /^Actions for/ }),
			).not.toBeInTheDocument();
		});

		it("names the speaker in the trigger and in the menu title", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={{
						id: "slot-3",
						role: "user",
						content: "Try again",
						status: "complete",
						createdAt: new Date(),
						anchorSeq: 2,
					}}
					onForkMessage={vi.fn()}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: "Actions for your message" }),
			);
			expect(screen.getByRole("dialog")).toHaveAccessibleName("Your message");
		});

		// The one reason the user can clear, so it is the one that says what to do.
		it("tells the user to respond to a request the message is holding", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={{ ...settled(), parts: [pendingRequest()] }}
					onForkMessage={vi.fn()}
				/>,
			);

			const fork = await openFork(user);
			expect(fork).toHaveAttribute("aria-disabled", "true");
			expect(fork).toHaveTextContent(
				"Respond to the request in this message first.",
			);
			// Disabled but reachable: the reason is worth nothing if focus and the
			// screen reader skip the row carrying it.
			fork.focus();
			expect(fork).toHaveFocus();
		});

		// Both reasons at once. Answering the request would not conjure a seq, so
		// the row must not send the user off to come back to the same grey row.
		it("names the missing seq over a request when both apply", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={{
						...settled(),
						anchorSeq: undefined,
						parts: [pendingRequest()],
					}}
					onForkMessage={vi.fn()}
				/>,
			);

			const fork = await openFork(user);
			expect(fork).toHaveTextContent(
				"This message has no saved position to fork from.",
			);
			expect(fork).not.toHaveTextContent("Respond to the request");
		});

		// The opening prompt whose record never persisted is both codes at once,
		// and the permanent one wins: pointing at the missing seq would name a
		// state whose clearing changes nothing, since nothing behind the first
		// message is coming back either way.
		it("names the opening message over a missing seq when both apply", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={{
						id: "slot-4",
						role: "user",
						content: "Try again",
						status: "complete",
						createdAt: new Date(),
					}}
					isFirst
					onForkMessage={vi.fn()}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: "Actions for your message" }),
			);
			const fork = screen.getByRole("button", { name: /Fork from here/ });
			expect(fork).toHaveTextContent("Nothing before this message to keep.");
			expect(fork).not.toHaveTextContent("no saved position");
		});

		it("forks the message the menu was opened from", async () => {
			const user = userEvent.setup();
			const onForkMessage = vi.fn();
			render(
				<MessageItem
					sessionId="session-1"
					message={settled()}
					onForkMessage={onForkMessage}
				/>,
			);

			await user.click(await openFork(user));

			expect(onForkMessage).toHaveBeenCalledWith("slot-1");
			// The menu steps aside for the confirmation that follows it.
			expect(screen.queryByRole("dialog")).toBeNull();
		});
	});

	// The summary rules themselves are covered in lib/toolSummary.test.ts; this
	// only checks that the call's input and the work dir reach the derivation.
	describe("file path display", () => {
		beforeEach(() => {
			mockWorkDir.value = "/Users/test/project";
		});

		it("shows a file call's path relative to the work directory", () => {
			const message: Message = {
				id: "fp-1",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "tool-fp-1",
							name: "Read",
							input: {
								file_path: "/Users/test/project/src/components/Button.tsx",
							},
							status: "success",
						},
					},
				],
				status: "complete",
				createdAt: new Date(),
			};

			render(<MessageItem sessionId="session-1" message={message} />);
			// Two spans: the directories may be cut, the file name may not.
			expect(screen.getByText("src/components/")).toBeInTheDocument();
			expect(screen.getByText("Button.tsx")).toBeInTheDocument();
		});
	});
});
