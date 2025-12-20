import { render, screen } from "@testing-library/react";
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

	it("renders assistant message content", () => {
		const message: Message = {
			id: "2",
			role: "assistant",
			content: "Hello human",
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

	it("renders tool calls", () => {
		const message: Message = {
			id: "5",
			role: "assistant",
			content: "I'll read the file",
			status: "complete",
			createdAt: new Date(),
			toolCalls: [{ name: "Read", input: { file: "test.go" } }],
		};

		render(<MessageItem message={message} />);
		expect(screen.getByText("Read")).toBeInTheDocument();
	});

	it("renders tool call with result", () => {
		const message: Message = {
			id: "6",
			role: "assistant",
			content: "",
			status: "complete",
			createdAt: new Date(),
			toolCalls: [
				{
					name: "Bash",
					input: { command: "ls" },
					result: "file1.txt\nfile2.txt",
				},
			],
		};

		render(<MessageItem message={message} />);
		expect(screen.getByText("Bash")).toBeInTheDocument();
		expect(screen.getByText(/file1\.txt/)).toBeInTheDocument();
		expect(screen.getByText(/file2\.txt/)).toBeInTheDocument();
	});

	it("preserves whitespace in message content", () => {
		const message: Message = {
			id: "7",
			role: "assistant",
			content: "Line 1\n  Indented line\nLine 3",
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem message={message} />);
		const paragraph = screen.getByText(/Line 1/);
		expect(paragraph).toHaveClass("whitespace-pre-wrap");
	});
});
