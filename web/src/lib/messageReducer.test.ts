import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, UserMessage } from "../types/message";
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

// Shared test fixtures
const sampleQuestions = [
	{
		question: "Which library?",
		header: "Library",
		options: [
			{ label: "React", description: "UI library" },
			{ label: "Vue", description: "Framework" },
		],
		multiSelect: false,
	},
];

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

		it("normalizes permission_request event", () => {
			const event = normalizeEvent({
				type: "permission_request",
				request_id: "req-1",
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
				tool_use_id: "tool-1",
				permission_suggestions: [
					{
						type: "addRules",
						rules: [{ toolName: "Bash", ruleContent: "rm:*" }],
						behavior: "allow",
						destination: "session",
					},
				],
			});
			expect(event).toEqual({
				type: "permission_request",
				requestId: "req-1",
				toolName: "Bash",
				toolInput: { command: "rm -rf /" },
				toolUseId: "tool-1",
				permissionSuggestions: [
					{
						type: "addRules",
						rules: [{ toolName: "Bash", ruleContent: "rm:*" }],
						behavior: "allow",
						destination: "session",
					},
				],
			});
		});

		it("normalizes permission_response event", () => {
			const event = normalizeEvent({
				type: "permission_response",
				request_id: "req-1",
				choice: "allow",
			});
			expect(event).toEqual({
				type: "permission_response",
				requestId: "req-1",
				choice: "allow",
			});
		});

		it("normalizes ask_user_question event", () => {
			const event = normalizeEvent({
				type: "ask_user_question",
				request_id: "q-1",
				tool_use_id: "toolu_q_1",
				questions: sampleQuestions,
			});
			expect(event).toEqual({
				type: "ask_user_question",
				requestId: "q-1",
				toolUseId: "toolu_q_1",
				questions: sampleQuestions,
			});
		});

		it("normalizes question_response event with answers", () => {
			const event = normalizeEvent({
				type: "question_response",
				request_id: "q-1",
				answers: { q1: "React" },
			});
			expect(event).toEqual({
				type: "question_response",
				requestId: "q-1",
				answers: { q1: "React" },
			});
		});

		it("normalizes question_response event with null answers (cancelled)", () => {
			const event = normalizeEvent({
				type: "question_response",
				request_id: "q-1",
				answers: null,
			});
			expect(event).toEqual({
				type: "question_response",
				requestId: "q-1",
				answers: null,
			});
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

		it("adds permission_request as pending", () => {
			const parts = applyEventToParts([], {
				type: "permission_request",
				requestId: "req-1",
				toolName: "Bash",
				toolInput: { command: "rm -rf /" },
				toolUseId: "tool-1",
			});
			expect(parts).toEqual([
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName: "Bash",
						toolInput: { command: "rm -rf /" },
						toolUseId: "tool-1",
						permissionSuggestions: undefined,
					},
					status: "pending",
				},
			]);
		});

		it("adds ask_user_question as pending", () => {
			const parts = applyEventToParts([], {
				type: "ask_user_question",
				requestId: "q-1",
				toolUseId: "toolu_q_1",
				questions: sampleQuestions,
			});
			expect(parts).toEqual([
				{
					type: "ask_user_question",
					request: {
						requestId: "q-1",
						toolUseId: "toolu_q_1",
						questions: sampleQuestions,
					},
					status: "pending",
				},
			]);
		});
	});

	describe("applyServerEvent", () => {
		const createStreamingMessage = (): AssistantMessage => ({
			id: "msg-1",
			role: "assistant",
			parts: [],
			status: "streaming",
			createdAt: new Date(),
		});

		it("creates new assistant message for orphan event", () => {
			const messages = applyServerEvent([], { type: "text", content: "Hello" });
			expect(messages).toHaveLength(1);
			expect(messages[0].role).toBe("assistant");
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts).toEqual([{ type: "text", content: "Hello" }]);
		});

		it("appends text to streaming message", () => {
			const initial = [createStreamingMessage()];
			const messages = applyServerEvent(initial, {
				type: "text",
				content: "Hello",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts).toEqual([{ type: "text", content: "Hello" }]);
			expect(assistant.status).toBe("streaming");
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
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.status).toBe("error");
			expect(assistant.error).toBe("Failed");
		});

		it("creates standalone message for system event", () => {
			const messages = applyServerEvent([], {
				type: "system",
				content: "Welcome",
			});
			expect(messages).toHaveLength(1);
			expect(messages[0].status).toBe("complete");
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts).toEqual([{ type: "system", content: "Welcome" }]);
		});

		it("updates permission_request status on permission_response allow", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
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
			const messages = applyServerEvent([initial], {
				type: "permission_response",
				requestId: "req-1",
				choice: "allow",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "allowed",
			});
		});

		it("updates permission_request status on permission_response deny", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
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
			const messages = applyServerEvent([initial], {
				type: "permission_response",
				requestId: "req-1",
				choice: "deny",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "denied",
			});
		});

		it("updates permission_request status on permission_response always_allow", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
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
			const messages = applyServerEvent([initial], {
				type: "permission_response",
				requestId: "req-1",
				choice: "always_allow",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "allowed",
			});
		});

		it("does not modify message when requestId not found", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
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
			const messages = applyServerEvent([initial], {
				type: "permission_response",
				requestId: "non-existent",
				choice: "allow",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "pending",
			});
			// Verify same object reference (no unnecessary copy)
			expect(messages[0]).toBe(initial);
		});

		it("updates ask_user_question status on question_response with answers", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "ask_user_question",
						request: {
							requestId: "q-1",
							toolUseId: "toolu_q_1",
							questions: sampleQuestions,
						},
						status: "pending",
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "question_response",
				requestId: "q-1",
				answers: { "Which library?": "React" },
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "ask_user_question",
				status: "answered",
				answers: { "Which library?": "React" },
			});
		});

		it("updates ask_user_question status on question_response with null (cancelled)", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "ask_user_question",
						request: {
							requestId: "q-1",
							toolUseId: "toolu_q_1",
							questions: sampleQuestions,
						},
						status: "pending",
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "question_response",
				requestId: "q-1",
				answers: null,
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "ask_user_question",
				status: "cancelled",
			});
		});

		it("does not modify message when question requestId not found", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "ask_user_question",
						request: {
							requestId: "q-1",
							toolUseId: "toolu_q_1",
							questions: sampleQuestions,
						},
						status: "pending",
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "question_response",
				requestId: "non-existent",
				answers: { "Which library?": "React" },
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "ask_user_question",
				status: "pending",
			});
			expect(messages[0]).toBe(initial);
		});

		it.each([
			{ type: "interrupted" as const },
			{ type: "process_ended" as const },
			{ type: "done" as const },
			{ type: "error" as const, error: "err" },
		])("ignores $type event when no active message exists", (event) => {
			const completed: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [{ type: "text", content: "Response" }],
				status: "complete",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([completed], event);
			expect(messages).toHaveLength(1);
			expect(messages[0]).toBe(completed); // Same reference, not modified
		});

		it("ignores terminal events when no assistant message exists", () => {
			const messages = applyServerEvent([], { type: "interrupted" });
			expect(messages).toHaveLength(0);
		});
	});

	describe("applyUserMessage", () => {
		it("adds user message and empty assistant message", () => {
			const messages = applyUserMessage([], "Hello AI");
			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("user");
			const user = messages[0] as UserMessage;
			expect(user.content).toBe("Hello AI");
			expect(messages[1].role).toBe("assistant");
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts).toEqual([]);
		});

		it("finalizes streaming assistant before adding user message", () => {
			const streaming: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
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
			const user = messages[0] as UserMessage;
			expect(user.content).toBe("Hello");
			expect(messages[1].role).toBe("assistant");
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts).toEqual([{ type: "text", content: "Hi there!" }]);
			expect(assistant.status).toBe("complete");
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
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toEqual({
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
			const assistant1 = messages[1] as AssistantMessage;
			expect(assistant1.parts).toEqual([
				{ type: "text", content: "Partial..." },
			]);
			const assistant2 = messages[3] as AssistantMessage;
			expect(assistant2.parts).toEqual([{ type: "text", content: "Complete" }]);
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
			const system = messages[0] as AssistantMessage;
			expect(system.parts).toEqual([{ type: "system", content: "Welcome!" }]);
			expect(system.status).toBe("complete");
			expect(messages[1].role).toBe("user");
			expect(messages[2].role).toBe("assistant");
		});

		it("replays permission_request with allow response as allowed", () => {
			const history = [
				{ type: "message", content: "Do something" },
				{
					type: "permission_request",
					request_id: "req-1",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
				},
				{ type: "permission_response", request_id: "req-1", choice: "allow" },
				{ type: "text", content: "Continuing..." },
				{ type: "done" },
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "allowed",
			});
		});

		it("replays permission_request with deny response as denied", () => {
			const history = [
				{ type: "message", content: "Do something" },
				{
					type: "permission_request",
					request_id: "req-1",
					tool_name: "Bash",
					tool_input: { command: "rm -rf /" },
					tool_use_id: "tool-1",
				},
				{ type: "permission_response", request_id: "req-1", choice: "deny" },
				{ type: "interrupted" },
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "denied",
			});
		});

		it("keeps pending status for permission_request without response", () => {
			const history = [
				{ type: "message", content: "Do something" },
				{
					type: "permission_request",
					request_id: "req-1",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
				},
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "pending",
			});
		});

		it("replays ask_user_question with answered response", () => {
			const history = [
				{ type: "message", content: "Help me choose" },
				{
					type: "ask_user_question",
					request_id: "q-1",
					tool_use_id: "toolu_q_1",
					questions: sampleQuestions,
				},
				{
					type: "question_response",
					request_id: "q-1",
					answers: { "Which library?": "React" },
				},
				{ type: "text", content: "Great choice!" },
				{ type: "done" },
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "ask_user_question",
				status: "answered",
				answers: { "Which library?": "React" },
			});
		});

		it("replays ask_user_question with cancelled response", () => {
			const history = [
				{ type: "message", content: "Help me choose" },
				{
					type: "ask_user_question",
					request_id: "q-1",
					tool_use_id: "toolu_q_1",
					questions: sampleQuestions,
				},
				{ type: "question_response", request_id: "q-1", answers: null },
				{ type: "interrupted" },
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "ask_user_question",
				status: "cancelled",
			});
		});

		it("keeps pending status for ask_user_question without response", () => {
			const history = [
				{ type: "message", content: "Help me choose" },
				{
					type: "ask_user_question",
					request_id: "q-1",
					tool_use_id: "toolu_q_1",
					questions: sampleQuestions,
				},
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "ask_user_question",
				status: "pending",
			});
		});
	});
});
