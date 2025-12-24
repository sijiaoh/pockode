import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Message } from "../../types/message";
import MessageItem from "./MessageItem";

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

	it("renders assistant message with text parts", () => {
		const message: Message = {
			id: "2",
			role: "assistant",
			content: "",
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
			content: "",
			status: "sending",
			createdAt: new Date(),
		};

		render(<MessageItem message={message} />);
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("shows error message for error status", () => {
		const message: Message = {
			id: "4",
			role: "assistant",
			content: "",
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
			content: "",
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
			content: "",
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
			content: "",
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

	it("preserves whitespace in text parts", () => {
		const message: Message = {
			id: "7",
			role: "assistant",
			content: "",
			parts: [{ type: "text", content: "Line 1\n  Indented line\nLine 3" }],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem message={message} />);
		const paragraph = screen.getByText(/Line 1/);
		expect(paragraph).toHaveClass("whitespace-pre-wrap");
	});

	it("renders parts in timeline order", () => {
		const message: Message = {
			id: "8",
			role: "assistant",
			content: "",
			parts: [
				{ type: "text", content: "First text" },
				{ type: "tool_call", tool: { id: "tool-3", name: "Read", input: {} } },
				{ type: "text", content: "Second text" },
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem message={message} />);

		const container = screen.getByText("First text").parentElement;
		const children = container?.children;

		// Verify order: text -> tool -> text
		expect(children?.[0]).toHaveTextContent("First text");
		expect(children?.[1]).toHaveTextContent("Read");
		expect(children?.[2]).toHaveTextContent("Second text");
	});
});
