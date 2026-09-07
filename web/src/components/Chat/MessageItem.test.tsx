import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types/message";
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

		render(<MessageItem message={message} />);
		expect(screen.getByText("Hello AI")).toBeInTheDocument();
	});

	describe("system message", () => {
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

		it("renders a collapsed banner with label and title summary", () => {
			render(<MessageItem message={systemMessage()} />);
			expect(screen.getByText("Pockode · Kickoff")).toBeInTheDocument();
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
			render(<MessageItem message={systemMessage()} />);
			await user.click(screen.getByRole("button"));
			expect(screen.getByText(/Do the thing/)).toBeInTheDocument();
			expect(screen.getByRole("button")).toHaveAttribute(
				"aria-expanded",
				"true",
			);
		});

		it("includes step context in the label for step_advance", () => {
			render(
				<MessageItem
					message={systemMessage({
						subtype: "step_advance",
						meta: { title: "My work", step: { current: 2, total: 3 } },
					})}
				/>,
			);
			expect(
				screen.getByText("Pockode · Next step (Step 2/3)"),
			).toBeInTheDocument();
		});

		it("falls back to a generic label for unknown subtypes", () => {
			render(
				<MessageItem
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
				<MessageItem message={systemMessage({ content: "raw prompt" })} />,
			);
			// The collapsed banner keeps the prompt hidden; a user bubble would show it.
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

		render(<MessageItem message={message} />);
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

		// sending always shows spinner, regardless of isProcessRunning
		render(<MessageItem message={message} />);
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("shows spinner for streaming status when process is running", () => {
		const message: Message = {
			id: "3",
			role: "assistant",
			parts: [],
			status: "streaming",
			createdAt: new Date(),
		};

		render(<MessageItem message={message} isLast isProcessRunning />);
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
			<MessageItem message={message} isLast={false} isProcessRunning={true} />,
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

		render(<MessageItem message={message} />);
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

		render(<MessageItem message={message} />);
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
					tool: { id: "tool-1", name: "Read", input: { file: "test.go" } },
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem message={message} />);
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
						result: "file1.txt\nfile2.txt",
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem message={message} />);
		expect(screen.getByText("Bash")).toBeInTheDocument();

		// Result is hidden by default (collapsed)
		expect(screen.queryByText(/file1\.txt/)).not.toBeInTheDocument();

		// Click to expand
		await user.click(screen.getByRole("button"));
		expect(screen.getByText(/file1\.txt/)).toBeInTheDocument();
		expect(screen.getByText(/file2\.txt/)).toBeInTheDocument();
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

		render(<MessageItem message={message} onPermissionRespond={vi.fn()} />);
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

		render(<MessageItem message={message} onPermissionRespond={onRespond} />);
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

		render(<MessageItem message={message} />);
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

		render(<MessageItem message={message} />);
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

		render(<MessageItem message={message} />);
		expect(screen.getByText("init")).toBeInTheDocument();
	});

	describe("file path display", () => {
		beforeEach(() => {
			mockWorkDir.value = "/Users/test/project";
		});

		it("shows filename with relative path for files within workDir", () => {
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
						},
					},
				],
				status: "complete",
				createdAt: new Date(),
			};

			render(<MessageItem message={message} />);
			expect(
				screen.getByText("Button.tsx (src/components)"),
			).toBeInTheDocument();
		});

		it("shows filename with parent dir only for files outside workDir", () => {
			const message: Message = {
				id: "fp-2",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "tool-fp-2",
							name: "Read",
							input: { file_path: "/etc/hosts" },
						},
					},
				],
				status: "complete",
				createdAt: new Date(),
			};

			render(<MessageItem message={message} />);
			expect(screen.getByText("hosts (etc)")).toBeInTheDocument();
		});

		it("shows filename only for files in workDir root", () => {
			const message: Message = {
				id: "fp-3",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "tool-fp-3",
							name: "Read",
							input: { file_path: "/Users/test/project/README.md" },
						},
					},
				],
				status: "complete",
				createdAt: new Date(),
			};

			render(<MessageItem message={message} />);
			expect(screen.getByText("README.md")).toBeInTheDocument();
		});
	});
});
