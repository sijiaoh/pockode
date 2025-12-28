import { describe, expect, it, vi } from "vitest";
import type { Message } from "../types/message";
import {
	applyEventToParts,
	applyServerEvent,
	applyUserMessage,
	normalizeEvent,
	replayHistory,
} from "./messageReducer";

// Mock UUID for deterministic tests
vi.mock("../utils/uuid", () => ({
	generateUUID: () => "test-uuid",
}));

describe("messageReducer", () => {
	describe("normalizeEvent", () => {
		it("normalizes tool_call event with snake_case to camelCase", () => {
			const event = normalizeEvent({
				type: "tool_call",
				tool_use_id: "tool-1",
				tool_name: "Bash",
				tool_input: { command: "ls" },
			});
			expect(event).toEqual({
				type: "tool_call",
				toolUseId: "tool-1",
				toolName: "Bash",
				toolInput: { command: "ls" },
			});
		});

		it("normalizes tool_result event", () => {
			const event = normalizeEvent({
				type: "tool_result",
				tool_use_id: "tool-1",
				tool_result: "file.txt",
			});
			expect(event).toEqual({
				type: "tool_result",
				toolUseId: "tool-1",
				toolResult: "file.txt",
			});
		});

		it("normalizes status events", () => {
			expect(normalizeEvent({ type: "done" })).toEqual({ type: "done" });
			expect(normalizeEvent({ type: "interrupted" })).toEqual({
				type: "interrupted",
			});
			expect(normalizeEvent({ type: "process_ended" })).toEqual({
				type: "process_ended",
			});
		});

		it("returns empty text for unknown event type", () => {
			const event = normalizeEvent({ type: "unknown_type" });
			expect(event).toEqual({ type: "text", content: "" });
		});
	});

	describe("applyEventToParts", () => {
		it("appends text to empty parts", () => {
			const parts = applyEventToParts([], { type: "text", content: "Hello" });
			expect(parts).toEqual([{ type: "text", content: "Hello" }]);
		});

		it("concatenates consecutive text events", () => {
			const parts1 = applyEventToParts([], { type: "text", content: "Hello " });
			const parts2 = applyEventToParts(parts1, {
				type: "text",
				content: "World",
			});
			expect(parts2).toEqual([{ type: "text", content: "Hello World" }]);
		});

		it("adds tool_call as new part", () => {
			const parts = applyEventToParts([{ type: "text", content: "Text" }], {
				type: "tool_call",
				toolUseId: "tool-1",
				toolName: "Bash",
				toolInput: { command: "ls" },
			});
			expect(parts).toEqual([
				{ type: "text", content: "Text" },
				{
					type: "tool_call",
					tool: { id: "tool-1", name: "Bash", input: { command: "ls" } },
				},
			]);
		});

		it("updates tool_call with result", () => {
			const parts = applyEventToParts(
				[
					{
						type: "tool_call",
						tool: { id: "tool-1", name: "Bash", input: { command: "ls" } },
					},
				],
				{ type: "tool_result", toolUseId: "tool-1", toolResult: "file.txt" },
			);
			expect(parts).toEqual([
				{
					type: "tool_call",
					tool: {
						id: "tool-1",
						name: "Bash",
						input: { command: "ls" },
						result: "file.txt",
					},
				},
			]);
		});
	});

	describe("applyServerEvent", () => {
		const createStreamingMessage = (): Message => ({
			id: "msg-1",
			role: "assistant",
			content: "",
			parts: [],
			status: "streaming",
			createdAt: new Date(),
		});

		it("creates new assistant message for orphan event", () => {
			const messages = applyServerEvent([], { type: "text", content: "Hello" });
			expect(messages).toHaveLength(1);
			expect(messages[0].role).toBe("assistant");
			expect(messages[0].parts).toEqual([{ type: "text", content: "Hello" }]);
		});

		it("appends text to streaming message", () => {
			const initial = [createStreamingMessage()];
			const messages = applyServerEvent(initial, {
				type: "text",
				content: "Hello",
			});
			expect(messages[0].parts).toEqual([{ type: "text", content: "Hello" }]);
			expect(messages[0].status).toBe("streaming");
		});

		it.each([
			{ event: { type: "done" as const }, expectedStatus: "complete" },
			{
				event: { type: "interrupted" as const },
				expectedStatus: "interrupted",
			},
			{
				event: { type: "process_ended" as const },
				expectedStatus: "process_ended",
			},
		])("sets status to $expectedStatus on $event.type event", ({
			event,
			expectedStatus,
		}) => {
			const initial = [createStreamingMessage()];
			const messages = applyServerEvent(initial, event);
			expect(messages[0].status).toBe(expectedStatus);
		});

		it("marks message as error with error message", () => {
			const initial = [createStreamingMessage()];
			const messages = applyServerEvent(initial, {
				type: "error",
				error: "Failed",
			});
			expect(messages[0].status).toBe("error");
			expect(messages[0].error).toBe("Failed");
		});

		it("creates standalone message for system event", () => {
			const messages = applyServerEvent([], {
				type: "system",
				content: "Welcome",
			});
			expect(messages).toHaveLength(1);
			expect(messages[0].status).toBe("complete");
			expect(messages[0].parts).toEqual([
				{ type: "system", content: "Welcome" },
			]);
		});
	});

	describe("applyUserMessage", () => {
		it("adds user message and empty assistant message", () => {
			const messages = applyUserMessage([], "Hello AI");
			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("user");
			expect(messages[0].content).toBe("Hello AI");
			expect(messages[1].role).toBe("assistant");
			expect(messages[1].parts).toEqual([]);
		});

		it("finalizes streaming assistant before adding user message", () => {
			const streaming: Message = {
				id: "msg-1",
				role: "assistant",
				content: "",
				parts: [{ type: "text", content: "Response" }],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyUserMessage([streaming], "Follow up");
			expect(messages[0].status).toBe("complete");
			expect(messages[1].role).toBe("user");
			expect(messages[2].role).toBe("assistant");
		});
	});

	describe("replayHistory", () => {
		it("replays user message + assistant response", () => {
			const history = [
				{ type: "message", content: "Hello" },
				{ type: "text", content: "Hi there!" },
				{ type: "done" },
			];
			const messages = replayHistory(history);
			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("user");
			expect(messages[0].content).toBe("Hello");
			expect(messages[1].role).toBe("assistant");
			expect(messages[1].parts).toEqual([
				{ type: "text", content: "Hi there!" },
			]);
			expect(messages[1].status).toBe("complete");
		});

		it("replays tool calls with results", () => {
			const history = [
				{ type: "message", content: "List files" },
				{
					type: "tool_call",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
				},
				{ type: "tool_result", tool_use_id: "tool-1", tool_result: "file.txt" },
				{ type: "done" },
			];
			const messages = replayHistory(history);
			expect(messages).toHaveLength(2);
			const assistantParts = messages[1].parts ?? [];
			expect(assistantParts[0]).toEqual({
				type: "tool_call",
				tool: {
					id: "tool-1",
					name: "Bash",
					input: { command: "ls" },
					result: "file.txt",
				},
			});
		});

		it("handles incomplete assistant without done event", () => {
			const history = [
				{ type: "message", content: "First" },
				{ type: "text", content: "Partial..." },
				{ type: "message", content: "Second" },
				{ type: "text", content: "Complete" },
				{ type: "done" },
			];
			const messages = replayHistory(history);
			expect(messages).toHaveLength(4);
			expect(messages[1].parts).toEqual([
				{ type: "text", content: "Partial..." },
			]);
			expect(messages[3].parts).toEqual([
				{ type: "text", content: "Complete" },
			]);
		});

		it("replays system message as standalone", () => {
			const history = [
				{ type: "system", content: "Welcome!" },
				{ type: "message", content: "Hello" },
				{ type: "text", content: "Hi!" },
				{ type: "done" },
			];
			const messages = replayHistory(history);
			expect(messages).toHaveLength(3);
			expect(messages[0].parts).toEqual([
				{ type: "system", content: "Welcome!" },
			]);
			expect(messages[0].status).toBe("complete");
			expect(messages[1].role).toBe("user");
			expect(messages[2].role).toBe("assistant");
		});
	});
});
