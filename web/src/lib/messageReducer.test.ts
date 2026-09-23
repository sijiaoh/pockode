import { describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	ContentPart,
	Message,
	SessionTurn,
	ToolRun,
	UserMessage,
} from "../types/message";
import {
	applyEventToParts,
	applyServerEvent,
	applyToolActivitySnapshot,
	applyUserMessage,
	expirePendingDialogs,
	isBackReference,
	normalizeEvent,
	prependHistoryPage,
	replayHistory,
	settleAgainstTurn,
	settleRunningToolRuns,
	stampMessageAnchorSeq,
} from "./messageReducer";

// Deterministic but distinct ids: whether a message keeps its id or gets a
// fresh one is itself under test (a new id would remount its bubble).
const uuidMock = vi.hoisted(() => {
	let counter = 0;
	return { generateUUID: () => `test-uuid-${++counter}` };
});
vi.mock("../utils/uuid", () => ({ generateUUID: uuidMock.generateUUID }));

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

const partsOf = (message: Message) =>
	message.role === "assistant" ? message.parts : [];

function turnState(
	phase: SessionTurn["phase"],
	extra: Partial<SessionTurn> = {},
): SessionTurn {
	return { phase, open: phase !== "idle", since: "", ...extra };
}

describe("settleAgainstTurn", () => {
	// The whole of what §2.4 is for: a server that died mid-stream wrote no
	// ending, so the transcript ends on a bubble that would otherwise spin
	// forever.
	const streaming = () =>
		replayHistory([
			{ type: "message", content: "Do it" },
			{ type: "text", content: "Working" },
		]);

	it("finishes a streaming bubble the way the turn ended", () => {
		expect(
			settleAgainstTurn(streaming(), turnState("idle")).at(-1),
		).toMatchObject({ status: "complete" });
		expect(
			settleAgainstTurn(
				streaming(),
				turnState("idle", { last_outcome: "aborted" }),
			).at(-1),
		).toMatchObject({ status: "interrupted" });
	});

	it("leaves a running turn's bubble streaming", () => {
		expect(
			settleAgainstTurn(streaming(), turnState("running")).at(-1),
		).toMatchObject({ status: "streaming" });
	});

	// A parked turn is producing nothing, which is the whole point of saying so.
	it("finishes a bubble the turn parked on background work", () => {
		expect(
			settleAgainstTurn(
				streaming(),
				turnState("blocked", {
					blockers: [{ kind: "background", raised_at: "" }],
				}),
			).at(-1),
		).toMatchObject({ status: "complete" });
	});

	const asked = () =>
		replayHistory([
			{ type: "message", content: "Allow it?" },
			{
				type: "permission_request",
				request_id: "p1",
				tool_name: "Bash",
				tool_use_id: "t1",
			},
		]);

	it("keeps a card the turn still lists as a blocker answerable", () => {
		const settled = settleAgainstTurn(
			asked(),
			turnState("blocked", {
				blockers: [{ kind: "permission", request_id: "p1", raised_at: "" }],
			}),
		);
		expect(partsOf(settled.at(-1) as Message)).toMatchObject([
			{ type: "permission_request", status: "pending" },
		]);
	});

	// The same transcript, a session that is blocked on something else: this
	// card's process is gone whatever else is going on.
	it("retires a card the turn does not list", () => {
		const settled = settleAgainstTurn(
			asked(),
			turnState("blocked", {
				blockers: [{ kind: "background", raised_at: "" }],
			}),
		);
		expect(partsOf(settled.at(-1) as Message)).toMatchObject([
			{ type: "permission_request", status: "expired" },
		]);
	});
});

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
				contents: undefined,
				isError: false,
			});
		});

		it("normalizes a tool_result that carried blocks", () => {
			const event = normalizeEvent({
				type: "tool_result",
				tool_use_id: "tool-1",
				tool_result: "",
				contents: [
					{ type: "text", text: "PDF file read" },
					{
						type: "file",
						file: { mime: "application/pdf", omitted: "binary" },
					},
				],
			});
			expect(event).toMatchObject({
				type: "tool_result",
				toolUseId: "tool-1",
				contents: [
					{ type: "text", text: "PDF file read" },
					{ type: "file", file: { mime: "application/pdf" } },
				],
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

		it("normalizes warning event", () => {
			const event = normalizeEvent({
				type: "warning",
				message: "Image not supported",
				code: "image_not_supported",
			});
			expect(event).toEqual({
				type: "warning",
				message: "Image not supported",
				code: "image_not_supported",
			});
		});

		it("returns raw event for unknown event type", () => {
			const event = normalizeEvent({ type: "unknown_type" });
			expect(event).toEqual({
				type: "raw",
				content: '{"type":"unknown_type"}',
			});
		});

		it("normalizes raw event", () => {
			const event = normalizeEvent({ type: "raw", content: '{"foo":"bar"}' });
			expect(event).toEqual({ type: "raw", content: '{"foo":"bar"}' });
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

		it("normalizes a legacy ask_user_question record", () => {
			const event = normalizeEvent({
				type: "ask_user_question",
				request_id: "q-1",
				tool_use_id: "toolu_q_1",
				questions: sampleQuestions,
			});
			expect(event).toEqual({
				type: "legacy_question",
				requestId: "q-1",
				toolUseId: "toolu_q_1",
				questions: sampleQuestions,
			});
		});

		it("defaults missing questions to [] to keep renderers safe", () => {
			const event = normalizeEvent({
				type: "ask_user_question",
				request_id: "q-1",
				tool_use_id: "toolu_q_1",
			});
			expect(event).toEqual({
				type: "legacy_question",
				requestId: "q-1",
				toolUseId: "toolu_q_1",
				questions: [],
			});
		});

		it("normalizes null question options to [] to keep renderers safe", () => {
			// Simulates the wire shape when Go marshals a nil `Options` slice.
			const payload: Record<string, unknown> = {
				type: "ask_user_question",
				request_id: "q-1",
				tool_use_id: "toolu_q_1",
				questions: [
					{
						question: "Pick one?",
						header: "Pick",
						options: null,
						multiSelect: false,
					},
				],
			};
			const event = normalizeEvent(payload);
			expect(event).toEqual({
				type: "legacy_question",
				requestId: "q-1",
				toolUseId: "toolu_q_1",
				questions: [
					{
						question: "Pick one?",
						header: "Pick",
						options: [],
						multiSelect: false,
					},
				],
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

		it("normalizes question_response event without answers key (cancelled)", () => {
			const event = normalizeEvent({
				type: "question_response",
				request_id: "q-1",
			});
			expect(event).toEqual({
				type: "question_response",
				requestId: "q-1",
				answers: null,
			});
		});

		it("normalizes request_cancelled event", () => {
			const event = normalizeEvent({
				type: "request_cancelled",
				request_id: "req-1",
			});
			expect(event).toEqual({
				type: "request_cancelled",
				requestId: "req-1",
				reason: undefined,
			});
		});

		// The reason decides which banner the card shows and, for work_closed,
		// whether it can be answered at all — so it has to survive the wire.
		it("carries the cancellation reason", () => {
			expect(
				normalizeEvent({
					type: "request_cancelled",
					request_id: "req-1",
					reason: "timeout",
				}),
			).toMatchObject({ reason: "timeout" });
		});

		// A value this build does not know is no reason at all: the banner then
		// says what is true of all of them, rather than a card rendering nothing.
		it("drops a reason it does not know", () => {
			expect(
				// Typed as a bare record on purpose: the wire can carry a value the
				// types here do not admit, which is the case under test.
				normalizeEvent({
					type: "request_cancelled",
					request_id: "req-1",
					reason: "abducted",
				} as Record<string, unknown>),
			).toMatchObject({ reason: undefined });
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
					tool: {
						id: "tool-1",
						name: "Bash",
						input: { command: "ls" },
						status: "running",
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

		// One card per question, not one card carrying the array: the records
		// written today are one question each, and sharing the renderer is the
		// whole reason an old transcript still draws.
		it("adds a legacy question as one pending card per question", () => {
			const parts = applyEventToParts([], {
				type: "legacy_question",
				requestId: "q-1",
				toolUseId: "toolu_q_1",
				questions: sampleQuestions,
			});
			expect(parts).toEqual([
				{
					type: "question_record",
					record: { requestId: "q-1", question: sampleQuestions[0] },
					status: "pending",
					legacy: true,
				},
			]);
		});

		it("replaces the ask tool's tool_call with the cards", () => {
			const withToolCall = applyEventToParts([], {
				type: "tool_call",
				toolUseId: "toolu_q_1",
				toolName: "AskUserQuestion",
				toolInput: { questions: sampleQuestions },
			});
			const parts = applyEventToParts(withToolCall, {
				type: "legacy_question",
				requestId: "q-1",
				toolUseId: "toolu_q_1",
				questions: sampleQuestions,
			});
			expect(parts).toEqual([
				{
					type: "question_record",
					record: { requestId: "q-1", question: sampleQuestions[0] },
					status: "pending",
					legacy: true,
				},
			]);
		});

		it("keeps unrelated tool_calls when the cards are added", () => {
			const parts = applyEventToParts(
				[
					{
						type: "tool_call",
						tool: {
							id: "tool-1",
							name: "Bash",
							input: { command: "ls" },
							status: "running",
						},
					},
				],
				{
					type: "legacy_question",
					requestId: "q-1",
					toolUseId: "toolu_q_1",
					questions: sampleQuestions,
				},
			);
			expect(parts).toHaveLength(2);
			expect(parts[0]).toMatchObject({ type: "tool_call" });
			expect(parts[1]).toMatchObject({ type: "question_record", legacy: true });
		});

		it("adds warning as new part", () => {
			const parts = applyEventToParts([{ type: "text", content: "Text" }], {
				type: "warning",
				message: "Image not supported",
				code: "image_not_supported",
			});
			expect(parts).toEqual([
				{ type: "text", content: "Text" },
				{
					type: "warning",
					message: "Image not supported",
					code: "image_not_supported",
				},
			]);
		});
	});

	describe("applyServerEvent", () => {
		const createStreamingMessage = (
			parts: ContentPart[] = [],
		): AssistantMessage => ({
			id: "msg-1",
			role: "assistant",
			parts,
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
			// With content: a turn that ends on `done` having written nothing is
			// dropped rather than kept as a blank bubble, which is its own test.
			const initial = [
				createStreamingMessage([{ type: "text", content: "Answer" }]),
			];
			const messages = applyServerEvent(initial, event);
			expect((messages[0] as AssistantMessage).status).toBe(expectedStatus);
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

		it("appends system message as content part", () => {
			const initial = [createStreamingMessage()];
			const messages = applyServerEvent(initial, {
				type: "system",
				content: "Compacting...",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts).toEqual([
				{ type: "system", content: "Compacting..." },
			]);
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

		it("updates permission_request status to expired on request_cancelled", () => {
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
				type: "request_cancelled",
				requestId: "req-1",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "expired",
			});
		});

		it("updates permission_request status to expired on request_cancelled", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "permission_request",
						request: {
							requestId: "q-1",
							toolName: "Bash",
							toolInput: { command: "ls" },
							toolUseId: "toolu_q_1",
						},
						status: "pending",
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "request_cancelled",
				requestId: "q-1",
				reason: "work_closed",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "expired",
				// Why it expired travels with it: the card says which of the three
				// things happened, and only this one makes it unanswerable.
				reason: "work_closed",
			});
		});

		// The same expiry reaches the client over two channels — the turn stops
		// listing the blocker, and the record says why — in either order. The
		// card that lost that race must not be stuck on the neutral banner.
		it("fills in the reason on a card that already expired", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "permission_request",
						request: {
							requestId: "q-1",
							toolName: "Bash",
							toolInput: { command: "ls" },
							toolUseId: "toolu_q_1",
						},
						status: "expired",
					},
				],
				status: "complete",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "request_cancelled",
				requestId: "q-1",
				reason: "timeout",
			});
			expect((messages[0] as AssistantMessage).parts[0]).toMatchObject({
				status: "expired",
				reason: "timeout",
			});
		});

		// The first record to name one is the one that settled it.
		it("does not overwrite a reason the card already has", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "permission_request",
						request: {
							requestId: "q-1",
							toolName: "Bash",
							toolInput: { command: "ls" },
							toolUseId: "toolu_q_1",
						},
						status: "expired",
						reason: "work_closed",
					},
				],
				status: "complete",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "request_cancelled",
				requestId: "q-1",
				reason: "process_ended",
			});
			expect((messages[0] as AssistantMessage).parts[0]).toMatchObject({
				reason: "work_closed",
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

		it("ignores late permission_response on already-expired permission", () => {
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
						status: "expired",
					},
				],
				status: "interrupted",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "permission_response",
				requestId: "req-1",
				choice: "allow",
			});
			expect(messages[0]).toBe(initial);
		});

		// A legacy card the CLI withdrew is settled, and a response arriving after
		// cannot reopen it.
		it("ignores a question_response for a card already cancelled", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "question_record",
						record: { requestId: "q-1", question: sampleQuestions[0] },
						legacy: true,
						status: "cancelled",
					},
				],
				status: "interrupted",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "question_response",
				requestId: "q-1",
				answers: { "Which library?": "React" },
			});
			expect(messages[0]).toBe(initial);
		});

		// The old flat answer string is parsed back into the halves a card draws,
		// so an answer given a year ago fills the read-only form in exactly as
		// today's does.
		it("answers a legacy card from the old flat answer string", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "question_record",
						record: { requestId: "q-1", question: sampleQuestions[0] },
						legacy: true,
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
			expect((messages[0] as AssistantMessage).parts[0]).toMatchObject({
				type: "question_record",
				status: "answered",
				answer: { answers: ["React"] },
			});
		});

		// The free text half of the same string, which the old format put behind
		// `Other: `. It lands in `text`, not in `answers` — a label the question
		// never offered would read as one it did.
		it("puts a legacy Other answer in text rather than among the labels", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "question_record",
						record: { requestId: "q-1", question: sampleQuestions[0] },
						legacy: true,
						status: "pending",
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], {
				type: "question_response",
				requestId: "q-1",
				answers: { "Which library?": "Other: Svelte, actually" },
			});
			expect((messages[0] as AssistantMessage).parts[0]).toMatchObject({
				status: "answered",
				answer: { answers: [], text: "Svelte, actually" },
			});
		});

		it("cancels a legacy card on a question_response with null answers", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "question_record",
						record: { requestId: "q-1", question: sampleQuestions[0] },
						legacy: true,
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
			expect((messages[0] as AssistantMessage).parts[0]).toMatchObject({
				type: "question_record",
				status: "cancelled",
			});
		});

		it("does not modify message when question requestId not found", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "question_record",
						record: { requestId: "q-1", question: sampleQuestions[0] },
						legacy: true,
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
			expect(messages[0]).toBe(initial);
		});

		it("expires pending permission_request on process_ended", () => {
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
			const messages = applyServerEvent([initial], { type: "process_ended" });
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "expired",
			});
		});

		// A question card is not a prompt a process holds open, and a process ending
		// is not an ending for it. That goes for a legacy card too: it is already
		// unanswerable and says so, and expiring it would be the second way of
		// saying one thing.
		it("leaves a question card alone on process_ended", () => {
			const initial: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "question_record",
						record: { requestId: "q-1", question: sampleQuestions[0] },
						status: "pending",
					},
					{
						type: "question_record",
						record: { requestId: "q-2", question: sampleQuestions[0] },
						legacy: true,
						status: "pending",
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], { type: "process_ended" });
			// Compared part by part: process_ended also finishes the streaming
			// bubble, so the message object itself is a new one either way.
			expect(partsOf(messages[0])).toEqual(initial.parts);
		});

		it("does not expire already-resolved dialogs on process_ended", () => {
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
						status: "allowed",
					},
					{
						type: "question_record",
						record: { requestId: "q-1", question: sampleQuestions[0] },
						legacy: true,
						status: "answered",
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([initial], { type: "process_ended" });
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "allowed",
			});
			expect(assistant.parts[1]).toMatchObject({
				type: "question_record",
				status: "answered",
			});
		});

		it("expires pending dialogs on orphan process_ended (after interrupted)", () => {
			const interrupted: AssistantMessage = {
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
				status: "interrupted",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([interrupted], {
				type: "process_ended",
			});
			const assistant = messages[0] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "expired",
			});
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

		it("updates tool_result in interrupted message", () => {
			const interrupted: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "tool-1",
							name: "Bash",
							input: { command: "ls" },
							status: "running",
						},
					},
				],
				status: "interrupted",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([interrupted], {
				type: "tool_result",
				toolUseId: "tool-1",
				toolResult: "file.txt",
				isError: false,
			});
			expect(messages).toHaveLength(1);
			const updated = messages[0] as AssistantMessage;
			expect(updated.parts[0]).toMatchObject({
				type: "tool_call",
				tool: { id: "tool-1", result: "file.txt" },
			});
		});

		it("carries a result's blocks onto the call that asked for it", () => {
			const streaming: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "tool-1",
							name: "Read",
							input: { file_path: "a.png" },
							status: "running",
						},
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([streaming], {
				type: "tool_result",
				toolUseId: "tool-1",
				toolResult: "",
				contents: [
					{ type: "file", file: { mime: "image/png", attachment_id: "abc" } },
				],
				isError: false,
			});
			expect((messages[0] as AssistantMessage).parts[0]).toMatchObject({
				type: "tool_call",
				tool: {
					id: "tool-1",
					contents: [
						{ type: "file", file: { mime: "image/png", attachment_id: "abc" } },
					],
				},
			});
		});

		// A Task reports in prose, and a result delivered as blocks carries that
		// prose inside them: the blocks are kept whole and the renderer reads the
		// prose out of them, so nothing about the result is decided twice.
		it("settles a Task that answered in blocks", () => {
			const streaming: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "tool-1",
							name: "Agent",
							input: { description: "Explore" },
							status: "running",
						},
					},
				],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([streaming], {
				type: "tool_result",
				toolUseId: "tool-1",
				toolResult: "",
				contents: [
					{ type: "text", text: "# Report" },
					{ type: "file", file: { mime: "image/png", attachment_id: "abc" } },
				],
				isError: false,
			});
			expect((messages[0] as AssistantMessage).parts[0]).toMatchObject({
				type: "tool_call",
				tool: {
					status: "success",
					contents: [{ type: "text", text: "# Report" }, { type: "file" }],
				},
			});
		});

		it("ignores orphan tool_result with no matching tool_call", () => {
			const completed: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [{ type: "text", content: "Hello" }],
				status: "complete",
				createdAt: new Date(),
			};
			const messages = applyServerEvent([completed], {
				type: "tool_result",
				toolUseId: "nonexistent",
				toolResult: "result",
				isError: false,
			});
			expect(messages).toHaveLength(1);
			expect(messages[0]).toBe(completed);
		});

		describe("late events after an ended turn", () => {
			const endedMessage = (
				status: AssistantMessage["status"],
			): AssistantMessage => ({
				id: "msg-1",
				role: "assistant",
				parts: [{ type: "text", content: "Working..." }],
				status,
				createdAt: new Date(),
			});

			it.each([
				"interrupted",
				"error",
				"process_ended",
			] as const)("keeps a %s turn ended when a Task's closing text arrives late", (status) => {
				const ended = endedMessage(status);
				const messages = applyServerEvent([ended], {
					type: "text",
					content: "Task done",
				});
				expect(messages).toHaveLength(1);
				const updated = messages[0] as AssistantMessage;
				expect(updated.status).toBe(status);
				expect(updated.parts).toEqual([
					{ type: "text", content: "Working...Task done" },
				]);
			});

			it("folds a late tool_call into the interrupted message", () => {
				const messages = applyServerEvent([endedMessage("interrupted")], {
					type: "tool_call",
					toolUseId: "tool-1",
					toolName: "Task",
					toolInput: {},
				});
				expect(messages).toHaveLength(1);
				const updated = messages[0] as AssistantMessage;
				expect(updated.status).toBe("interrupted");
				expect(updated.parts).toHaveLength(2);
			});

			it("starts a live turn again once a new message arrives", () => {
				let messages = applyServerEvent([endedMessage("interrupted")], {
					type: "text",
					content: "Task done",
				});
				messages = applyServerEvent(messages, {
					type: "message",
					content: "carry on",
				});
				messages = applyServerEvent(messages, {
					type: "text",
					content: "Sure",
				});
				const last = messages[messages.length - 1] as AssistantMessage;
				expect(last.status).toBe("streaming");
			});

			// Pockode ends the turn itself when a background wait runs out of
			// budget; output resuming after that is a live turn, not late output.
			it("opens a live turn for output after a completed turn", () => {
				const completed: AssistantMessage = {
					id: "msg-1",
					role: "assistant",
					parts: [{ type: "text", content: "Done" }],
					status: "complete",
					createdAt: new Date(),
				};
				const messages = applyServerEvent([completed], {
					type: "text",
					content: "Back from the background task",
				});
				expect(messages).toHaveLength(2);
				expect((messages[1] as AssistantMessage).status).toBe("streaming");
			});
		});

		describe("consecutive sends", () => {
			it("appends content to the last sending message only", () => {
				const a1: AssistantMessage = {
					id: "a1",
					role: "assistant",
					parts: [],
					status: "sending",
					createdAt: new Date(),
				};
				const a2: AssistantMessage = {
					id: "a2",
					role: "assistant",
					parts: [],
					status: "sending",
					createdAt: new Date(),
				};
				const messages = applyServerEvent([a1, a2], {
					type: "text",
					content: "Hello",
				});
				expect(messages).toHaveLength(2);
				expect((messages[0] as AssistantMessage).parts).toEqual([]);
				expect((messages[1] as AssistantMessage).parts).toEqual([
					{ type: "text", content: "Hello" },
				]);
			});

			it("removes orphan empty sending messages on terminal event", () => {
				const a1: AssistantMessage = {
					id: "a1",
					role: "assistant",
					parts: [],
					status: "sending",
					createdAt: new Date(),
				};
				const a2: AssistantMessage = {
					id: "a2",
					role: "assistant",
					parts: [{ type: "text", content: "Hello" }],
					status: "streaming",
					createdAt: new Date(),
				};
				const messages = applyServerEvent([a1, a2], { type: "done" });
				expect(messages).toHaveLength(1); // a1 removed
				expect(messages[0].id).toBe("a2");
				expect((messages[0] as AssistantMessage).status).toBe("complete");
			});

			// The reply goes to the message that is still waiting for one, not to
			// the one typed underneath it while the agent had yet to say anything.
			it("answers into the placeholder above a message sent since", () => {
				const a1: AssistantMessage = {
					id: "a1",
					role: "assistant",
					parts: [],
					status: "sending",
					createdAt: new Date(),
				};
				const user: UserMessage = {
					id: "u1",
					role: "user",
					content: "Second message",
					status: "complete",
					createdAt: new Date(),
				};
				const messages = applyServerEvent([a1, user], {
					type: "text",
					content: "Response",
				});
				expect(messages).toHaveLength(2);
				expect(messages[0].id).toBe("a1");
				expect((messages[0] as AssistantMessage).parts).toEqual([
					{ type: "text", content: "Response" },
				]);
				expect(messages[1]).toBe(user);
			});
		});

		describe("user message broadcast", () => {
			it("adds user message from broadcast to empty state", () => {
				const messages = applyServerEvent([], {
					type: "message",
					content: "Hello from another tab",
				});
				expect(messages).toHaveLength(2);
				expect(messages[0].role).toBe("user");
				const user = messages[0] as UserMessage;
				expect(user.content).toBe("Hello from another tab");
				expect(messages[1].role).toBe("assistant");
				// createAssistantMessage defaults to "streaming" status
				expect((messages[1] as AssistantMessage).status).toBe("streaming");
			});

			// Another tab sending mid-reply reaches the same CLI and steers the same
			// turn, so it shapes the transcript exactly as a local send does.
			it("leaves a streaming assistant open under a broadcast message", () => {
				const streaming: AssistantMessage = {
					id: "msg-1",
					role: "assistant",
					parts: [{ type: "text", content: "Previous response" }],
					status: "streaming",
					createdAt: new Date(),
				};
				const messages = applyServerEvent([streaming], {
					type: "message",
					content: "New message from another tab",
				});
				expect(messages).toHaveLength(2);
				expect((messages[0] as AssistantMessage).status).toBe("streaming");
				expect(messages[1].role).toBe("user");
				expect((messages[1] as UserMessage).content).toBe(
					"New message from another tab",
				);
			});
		});

		describe("system message", () => {
			it("normalizes message event with system origin, subtype and meta", () => {
				const event = normalizeEvent({
					type: "message",
					content: "kickoff prompt",
					origin: "system",
					subtype: "kickoff",
					meta: { title: "My work", step: { current: 1, total: 3 } },
				});
				expect(event).toEqual({
					type: "message",
					content: "kickoff prompt",
					origin: "system",
					subtype: "kickoff",
					meta: { title: "My work", step: { current: 1, total: 3 } },
				});
			});

			// An answer another agent gave is neither a user bubble nor a system
			// line, and the bubble has to be able to tell: `source` is what it
			// reads, so the origin must survive normalisation and be carried onto
			// the message.
			it("carries an agent origin through to the message", () => {
				const messages = applyServerEvent([], {
					type: "message",
					content: "Answering — not the user…",
					origin: "agent",
					answering: [
						{
							request_id: "r1",
							answers: ["Postgres"],
							answered_at: "2026-01-02T14:05:00Z",
							resolved_by: { kind: "agent", work_id: "w1", title: "Ship it" },
						},
					],
				});
				const message = messages[0];
				expect(message.role === "user" && message.source).toBe("agent");
				expect(message.role === "user" && message.answering).toHaveLength(1);
			});

			it("normalizes legacy 'work' origin to 'system' (backward compat)", () => {
				// Legacy wire data predating the rename, so it is an untyped record.
				const event = normalizeEvent({
					type: "message",
					content: "kickoff prompt",
					origin: "work",
					subtype: "kickoff",
				} as Record<string, unknown>);
				expect(event).toMatchObject({ type: "message", origin: "system" });
			});

			it("tags user message with system source and meta", () => {
				const messages = applyServerEvent([], {
					type: "message",
					content: "kickoff prompt",
					origin: "system",
					subtype: "kickoff",
					meta: { title: "My work" },
				});
				const user = messages[0] as UserMessage;
				expect(user.role).toBe("user");
				expect(user.source).toBe("system");
				expect(user.subtype).toBe("kickoff");
				expect(user.meta).toEqual({ title: "My work" });
			});

			it("leaves plain user messages without a system source (backward compat)", () => {
				const messages = applyServerEvent([], {
					type: "message",
					content: "plain user message",
				});
				const user = messages[0] as UserMessage;
				expect(user.source).toBeUndefined();
				expect(user.subtype).toBeUndefined();
				expect(user.meta).toBeUndefined();
			});
		});
	});

	describe("work event messages", () => {
		const systemEvent = (
			content: string,
			subtype: string,
			meta: Record<string, unknown>,
		) =>
			normalizeEvent({
				type: "message",
				content,
				origin: "system",
				subtype,
				meta,
			});

		const workMeta = {
			work_id: "work-1",
			work_type: "task",
			title: "Ship the card",
		};
		const kickoff = systemEvent("kickoff prompt", "kickoff", {
			...workMeta,
			step: { current: 1, total: 3 },
		});
		const stepAdvance = systemEvent("next step prompt", "step_advance", {
			...workMeta,
			step: { current: 2, total: 3 },
		});

		it("lands each event in the stream where it happened", () => {
			const messages = applyServerEvent([], kickoff);

			const event = messages[0] as UserMessage;
			expect(event.role).toBe("user");
			expect(event.source).toBe("system");
			expect(event.subtype).toBe("kickoff");
			expect(event.content).toBe("kickoff prompt");
			expect(event.meta).toMatchObject({
				work_id: "work-1",
				title: "Ship the card",
				step: { current: 1, total: 3 },
			});
			// The system message still drives the agent, so a reply placeholder
			// follows it exactly as it would a user message.
			expect(messages[1].role).toBe("assistant");
		});

		it("keeps later events of the same work as their own messages", () => {
			const messages = applyServerEvent(
				applyServerEvent([], kickoff),
				stepAdvance,
			);

			const events = messages.filter(
				(m): m is UserMessage => m.role === "user",
			);
			expect(events.map((m) => m.subtype)).toEqual(["kickoff", "step_advance"]);
			// Nothing extra marks the step change: the step_advance message is
			// already at the point the step changed and says so itself. Only the
			// two events and the placeholder for the reply the second provokes.
			expect(messages).toHaveLength(3);
		});

		// The turn that is writing ends on its own ending, not on the next message
		// arriving below it — a system-driven message is no different.
		it("leaves a streaming assistant open above the event", () => {
			const streaming = applyServerEvent([], { type: "text", content: "hi" });
			const messages = applyServerEvent(streaming, kickoff);

			expect((messages[0] as AssistantMessage).status).toBe("streaming");
			expect((messages[1] as UserMessage).source).toBe("system");
			expect(messages).toHaveLength(2);
		});

		it("treats history recorded without a work_id the same way", () => {
			const legacy = normalizeEvent({
				type: "message",
				content: "kickoff prompt",
				origin: "system",
				subtype: "kickoff",
				meta: { title: "Ship the card" },
			});

			const event = applyServerEvent([], legacy)[0] as UserMessage;
			expect(event.source).toBe("system");
			expect(event.meta?.work_id).toBeUndefined();
		});
	});

	// Every incoming message leaves a placeholder for the reply it provokes. When
	// the agent answers with nothing at all, that placeholder renders as a blank
	// bubble — visible on both message paths.
	describe("placeholders the agent never wrote into", () => {
		const placeholder = (
			status: AssistantMessage["status"],
			extra: Partial<AssistantMessage> = {},
		): AssistantMessage => ({
			id: "placeholder-1",
			role: "assistant",
			parts: [],
			status,
			createdAt: new Date(),
			...extra,
		});

		const systemMessage = normalizeEvent({
			type: "message",
			content: "auto continue",
			origin: "system",
			subtype: "auto_continue",
			meta: { work_id: "work-1", work_type: "task", title: "Ship the card" },
		});

		it("drops the empty one preceding a user message", () => {
			const messages = applyUserMessage([placeholder("complete")], "Follow up");

			expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		});

		it("drops the empty one preceding a system message", () => {
			const messages = applyServerEvent(
				[placeholder("complete")],
				systemMessage,
			);

			expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		});

		// Not dropped: it is the open turn, and the follow-up went into that turn.
		// It is emptiness plus an *ending* that makes a placeholder disposable, and
		// the ending has not arrived — see "drops a turn that ends on done having
		// written nothing" below for where it gets collected.
		it("keeps one the agent is still free to write into", () => {
			const messages = applyUserMessage(
				[placeholder("streaming")],
				"Follow up",
			);

			expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
		});

		it("keeps one the agent did write into", () => {
			const answered = placeholder("complete", {
				parts: [{ type: "text", content: "Done" }],
			});

			const messages = applyUserMessage([answered], "Follow up");

			expect(messages.map((m) => m.role)).toEqual([
				"assistant",
				"user",
				"assistant",
			]);
		});

		// These three say everything they have to say in the status line, so an
		// empty body is exactly when they matter. Dropping them would swallow an
		// aborted turn — and an interrupt is the case that produces them most.
		it.each([
			"interrupted",
			"error",
			"process_ended",
		] as const)("keeps an empty %s turn, whose status is the whole message", (status) => {
			const messages = applyUserMessage([placeholder(status)], "Follow up");

			expect(messages.map((m) => m.role)).toEqual([
				"assistant",
				"user",
				"assistant",
			]);
			expect((messages[0] as AssistantMessage).status).toBe(status);
		});

		// The second one arrives into the turn the first opened, so the first's
		// placeholder stays — and is collected when that turn ends having written
		// nothing, which is what leaves no blank bubble behind.
		it("leaves no blank bubble between two system messages", () => {
			let messages = applyServerEvent([], systemMessage);
			messages = applyServerEvent(messages, systemMessage);
			expect(messages.map((m) => m.role)).toEqual([
				"user",
				"assistant",
				"user",
			]);

			messages = applyServerEvent(messages, { type: "done" });
			expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
		});

		// A turn can also end at the tail of the transcript with nothing written:
		// an auto-continue the agent answers with silence does exactly that, right
		// before the retry limit stops the work.
		it("drops a turn that ends on done having written nothing", () => {
			const messages = applyServerEvent([placeholder("streaming")], {
				type: "done",
			});

			expect(messages).toEqual([]);
		});

		it.each([
			{ type: "interrupted" } as const,
			{ type: "process_ended" } as const,
			{ type: "error", error: "boom" } as const,
		])("keeps a turn that ends as $type with nothing written", (event) => {
			const messages = applyServerEvent([placeholder("streaming")], event);

			expect(messages).toHaveLength(1);
			expect((messages[0] as AssistantMessage).status).toBe(event.type);
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

		// The whole of the mid-turn send: the reply being written belongs to the
		// turn that was already running, not to what was just typed, so it is
		// neither closed nor given a sibling placeholder — it keeps growing where
		// it is and the message lands underneath it.
		it("leaves a streaming reply open and appends below it", () => {
			const streaming: AssistantMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [{ type: "text", content: "Response" }],
				status: "streaming",
				createdAt: new Date(),
			};
			const messages = applyUserMessage([streaming], "Also look at X");

			expect(messages).toHaveLength(2);
			expect((messages[0] as AssistantMessage).status).toBe("streaming");
			expect(messages[1].role).toBe("user");
		});
	});

	// A turn's bubble is opened by its first content event and closed by its
	// terminal event — never by a user message arriving underneath it.
	describe("turn boundaries with a message sent mid-turn", () => {
		const midTurn = () => {
			const messages = applyServerEvent([], {
				type: "text",
				content: "first half",
			});
			return applyUserMessage(messages, "Also look at X");
		};

		it("keeps streaming into the reply above the message", () => {
			const messages = applyServerEvent(midTurn(), {
				type: "text",
				content: " second half",
			});

			expect(messages).toHaveLength(2);
			expect(partsOf(messages[0])).toEqual([
				{ type: "text", content: "first half second half" },
			]);
			expect(messages[1].role).toBe("user");
		});

		it("still closes that reply on the turn's own ending", () => {
			const messages = applyServerEvent(midTurn(), { type: "done" });

			expect((messages[0] as AssistantMessage).status).toBe("complete");
			expect(messages[1].role).toBe("user");
			expect(messages).toHaveLength(2);
		});

		it("opens a fresh bubble for what comes after the ending", () => {
			let messages = applyServerEvent(midTurn(), { type: "done" });
			messages = applyServerEvent(messages, {
				type: "text",
				content: "about X",
			});

			expect(messages).toHaveLength(3);
			expect(messages[1].role).toBe("user");
			expect(partsOf(messages[2])).toEqual([
				{ type: "text", content: "about X" },
			]);
		});

		// The dependency this design accepts, stated so that breaking it breaks a
		// red test rather than a silent assumption: a user message used to close
		// the previous turn as well, which doubled as a backstop for a lost `done`.
		// That backstop is gone — `done` is now the only thing separating one
		// turn's output from the next's.
		it("merges two turns into one bubble when the ending is lost", () => {
			let messages = midTurn();
			messages = applyServerEvent(messages, {
				type: "text",
				content: " about X",
			});

			expect(messages).toHaveLength(2);
			expect(partsOf(messages[0])).toEqual([
				{ type: "text", content: "first half about X" },
			]);
		});

		// The mid-turn rule fixes an older misplacement on the way past: two
		// messages sent back to back used to drop the first one's placeholder, so
		// the first reply landed under the second message.
		it("answers two messages sent back to back in their own bubbles", () => {
			let messages = applyUserMessage([], "first");
			messages = applyUserMessage(messages, "second");
			expect(messages.map((m) => m.role)).toEqual([
				"user",
				"assistant",
				"user",
			]);

			messages = applyServerEvent(messages, {
				type: "text",
				content: "answer to first",
			});
			expect(partsOf(messages[1])).toEqual([
				{ type: "text", content: "answer to first" },
			]);

			messages = applyServerEvent(messages, { type: "done" });
			messages = applyServerEvent(messages, {
				type: "text",
				content: "answer to second",
			});
			expect(messages.map((m) => m.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			expect(partsOf(messages[3])).toEqual([
				{ type: "text", content: "answer to second" },
			]);
		});

		// A refused send leaves its reason below the message, so the running turn
		// is no longer the last assistant in the list. Finding it anyway is what
		// keeps its `done` from being dropped as belonging to no one, which would
		// leave a spinner nothing on screen could stop.
		it("keeps writing to the running turn under a failed send's reason", () => {
			const failed: AssistantMessage = {
				id: "send-failed",
				role: "assistant",
				parts: [],
				status: "error",
				error: "Failed to send message: connection lost",
				createdAt: new Date(),
			};
			let messages = [...midTurn(), failed];

			messages = applyServerEvent(messages, {
				type: "text",
				content: " second half",
			});
			expect(partsOf(messages[0])).toEqual([
				{ type: "text", content: "first half second half" },
			]);

			messages = applyServerEvent(messages, { type: "done" });
			expect((messages[0] as AssistantMessage).status).toBe("complete");
			expect(messages.map((m) => m.role)).toEqual([
				"assistant",
				"user",
				"assistant",
			]);
		});

		// Output the CLI was already producing when the turn was cut short belongs
		// to the turn it was cut from, which is the bubble above the message — not
		// to the message, which the agent never got to.
		it("keeps output trailing an interrupt in the interrupted bubble", () => {
			let messages = applyServerEvent(midTurn(), { type: "interrupted" });
			messages = applyServerEvent(messages, {
				type: "text",
				content: " trailing",
			});

			expect(messages).toHaveLength(2);
			expect((messages[0] as AssistantMessage).status).toBe("interrupted");
			expect(partsOf(messages[0])).toEqual([
				{ type: "text", content: "first half trailing" },
			]);
		});
	});

	// The one rule the transcript has for splitting a turn into two bubbles: the
	// agent has read the message that arrived mid-reply, so what it writes next
	// answers *that* message and belongs under it. Whichever CLI is behind it —
	// the record is the same, and no branch here asks which one
	// (docs/code/agent-integration.md#the-read-point).
	describe("the read point", () => {
		const midTurn = () => {
			const messages = applyServerEvent([], {
				type: "text",
				content: "first half",
			});
			return applyUserMessage(messages, "Also look at X");
		};

		// Recognised, and reduced to the boundary it is: an unhandled type falls
		// back to `raw`, which would put the record's own JSON on screen as a
		// message. `message_id` is dropped with it — the cut is made by position,
		// not by joining on that id.
		it("is a boundary, not content", () => {
			expect(
				normalizeEvent({ type: "message_ingested", message_id: "m-1" }),
			).toEqual({ type: "message_ingested" });
		});

		it("answers below the message instead of above it", () => {
			let messages = applyServerEvent(midTurn(), {
				type: "message_ingested",
			});
			messages = applyServerEvent(messages, {
				type: "text",
				content: "about X",
			});

			expect(messages.map((m) => m.role)).toEqual([
				"assistant",
				"user",
				"assistant",
			]);
			// The half written before the read point stays where it was: it was
			// never an answer to this message, and it is finished.
			expect(partsOf(messages[0])).toEqual([
				{ type: "text", content: "first half" },
			]);
			expect((messages[0] as AssistantMessage).status).toBe("complete");
			expect(partsOf(messages[2])).toEqual([
				{ type: "text", content: "about X" },
			]);
		});

		// A message sent before the agent had written a word: the bubble it cuts
		// is empty, and an empty bubble is dropped rather than left as a blank box
		// above the message.
		it("leaves no blank bubble behind when nothing was written yet", () => {
			let messages = applyUserMessage([], "first");
			messages = applyUserMessage(messages, "second");
			messages = applyServerEvent(messages, { type: "message_ingested" });

			expect(messages.map((m) => m.role)).toEqual([
				"user",
				"user",
				"assistant",
			]);
			expect(partsOf(messages[2])).toEqual([]);
		});

		// The turn's opening message gets no such record from the server, and a
		// build that wrote one anyway must not cost the transcript an empty bubble
		// above the first message: the placeholder it cuts is empty, so it is
		// dropped as the replacement is opened.
		it("costs no extra bubble on a turn's opening message", () => {
			const opened = applyUserMessage([], "first");
			const cut = applyServerEvent(opened, { type: "message_ingested" });

			expect(cut.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(partsOf(cut[1])).toEqual([]);
		});

		// Unconditional even with nothing open: a page of history that begins at a
		// read point has nothing to cut here — the bubble it cut is in the page
		// below — and the bubble opened for it is what says where the page starts.
		it("opens a bubble even when nothing is open to cut", () => {
			const messages = applyServerEvent([], { type: "message_ingested" });

			expect(messages.map((m) => m.role)).toEqual(["assistant"]);
			expect((messages[0] as AssistantMessage).openedAtReadPoint).toBe(true);
		});

		// Two messages queued into one running turn, each read at its own point.
		// Each answer starts where the agent picked that message up; what the
		// split cannot promise is sentence-level attribution, since the model
		// routinely folds both answers into one paragraph.
		it("gives each queued message its own bubble", () => {
			let messages = midTurn();
			messages = applyUserMessage(messages, "And Y");
			messages = applyServerEvent(messages, { type: "message_ingested" });
			messages = applyServerEvent(messages, {
				type: "text",
				content: "about X",
			});
			messages = applyServerEvent(messages, { type: "message_ingested" });
			messages = applyServerEvent(messages, {
				type: "text",
				content: "about Y",
			});

			expect(messages.map((m) => m.role)).toEqual([
				"assistant",
				"user",
				"user",
				"assistant",
				"assistant",
			]);
			expect(partsOf(messages[3])).toEqual([
				{ type: "text", content: "about X" },
			]);
			expect(partsOf(messages[4])).toEqual([
				{ type: "text", content: "about Y" },
			]);
		});

		// The cut can land in the middle of a tool call: on the agent that reports
		// no read point of its own the record is written at the moment of
		// delivery, which is typically while a command is still running. The call
		// stays where it was and its result still settles it — but an aborted turn
		// is the case where no result is coming, and the ending only ever swept
		// the bubble it landed in, so the call would spin for ever in the bubble
		// the turn had already moved past.
		it("settles a call the cut left behind when the turn is aborted", () => {
			let messages = applyServerEvent([], {
				type: "text",
				content: "first half",
			});
			messages = applyServerEvent(messages, {
				type: "tool_call",
				toolUseId: "tool-1",
				toolName: "Bash",
				toolInput: { command: "sleep 8" },
			});
			messages = applyUserMessage(messages, "Also look at X");
			messages = applyServerEvent(messages, { type: "message_ingested" });
			messages = applyServerEvent(messages, { type: "interrupted" });

			const cutBubble = messages[0] as AssistantMessage;
			const call = cutBubble.parts[1];
			if (call.type !== "tool_call") {
				throw new Error(
					`expected the call to still be there, got ${call.type}`,
				);
			}
			expect(call.tool.status).toBe("interrupted");
		});

		// A page boundary can fall on a read point, and then the page above opens
		// on a bubble no message event preceded — the same shape as content
		// trailing a turn cut in half by the page size, which `prependHistoryPage`
		// joins back onto the page below. Joining *this* one would undo the cut and
		// put the second message's answer back in the first message's bubble, which
		// is the bug the whole story is about, reappearing once per page boundary.
		it("keeps the cut when a page boundary falls on it", () => {
			// Two messages queued into one running turn, read one after the other,
			// with the page boundary between the two read points.
			const older = replayHistory([
				{ type: "message", content: "do the thing" },
				{ type: "text", content: "first half" },
				{ type: "message", content: "Also look at X" },
				{ type: "message", content: "And Y" },
				{ type: "message_ingested", message_id: "m-2" },
				{ type: "text", content: "about X" },
			]);
			const newer = replayHistory([
				{ type: "message_ingested", message_id: "m-3" },
				{ type: "text", content: "about Y" },
				{ type: "done" },
			]);

			const joined = prependHistoryPage(older, newer);

			expect(partsOf(joined[joined.length - 2])).toEqual([
				{ type: "text", content: "about X" },
			]);
			expect(partsOf(joined[joined.length - 1])).toEqual([
				{ type: "text", content: "about Y" },
			]);
		});

		// The join that must still happen: a boundary falling *inside* the bubble a
		// read point opened leaves the rest of it leading the page above, and that
		// is one bubble in two halves.
		it("still joins a bubble a boundary cut in half", () => {
			const older = replayHistory([
				{ type: "message", content: "do the thing" },
				{ type: "text", content: "first half" },
				{ type: "message", content: "Also look at X" },
				{ type: "message_ingested", message_id: "m-2" },
				{ type: "text", content: "about " },
			]);
			const newer = replayHistory([
				{ type: "text", content: "X" },
				{ type: "done" },
			]);

			const joined = prependHistoryPage(older, newer);

			expect(joined.map((m) => m.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			expect(partsOf(joined[3])).toEqual([
				{ type: "text", content: "about X" },
			]);
		});

		// The acceptance criterion the whole design hangs on: the split lives in
		// history, so a refresh reads back what the live stream drew.
		it("replays to the same split the live stream drew", () => {
			const records = [
				{ type: "message", content: "do the thing" },
				{ type: "text", content: "first half" },
				{ type: "message", content: "Also look at X" },
				{ type: "message_ingested", message_id: "m-2" },
				{ type: "text", content: "about X" },
				{ type: "done" },
			];

			const live = records.reduce<Message[]>(
				(acc, record) =>
					applyServerEvent(acc, normalizeEvent(record), undefined, {
						live: true,
					}),
				[],
			);
			const replayed = replayHistory(records);

			const shape = (messages: Message[]) =>
				messages.map((m) => ({ role: m.role, parts: partsOf(m) }));
			expect(shape(replayed)).toEqual(shape(live));
			expect(shape(replayed)).toEqual([
				{ role: "user", parts: [] },
				{ role: "assistant", parts: [{ type: "text", content: "first half" }] },
				{ role: "user", parts: [] },
				{ role: "assistant", parts: [{ type: "text", content: "about X" }] },
			]);
		});
	});

	// A turn parking on background work is recorded so the *session* can say the
	// agent is waiting rather than thinking
	// (docs/code/agent-integration.md#background-waits). Drawing it is not wired
	// up, and until it is the record has to leave the transcript alone — an
	// unhandled type falls back to `raw`, which would put the record's own JSON
	// on screen as a message.
	describe("background_wait", () => {
		it("leaves the transcript exactly as it was", () => {
			const before = replayHistory([
				{ type: "message", content: "Run it in the background", seq: 1 },
				{ type: "text", content: "Started.", seq: 2 },
			]);

			const after = applyServerEvent(
				before,
				normalizeEvent({ type: "background_wait" }),
				3,
			);

			expect(after).toBe(before);
		});

		it("does not open a bubble of its own between turns", () => {
			const messages = replayHistory([
				{ type: "message", content: "Run it", seq: 1 },
				{ type: "text", content: "Started.", seq: 2 },
				{ type: "background_wait", seq: 3 },
				{ type: "text", content: "Finished.", seq: 4 },
				{ type: "done", seq: 5 },
			]);

			expect(messages).toHaveLength(2);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.status).toBe("complete");
			expect(assistant.parts).toEqual([
				{ type: "text", content: "Started.Finished." },
			]);
			// The wait carries no address of its own: the message it did not touch
			// keeps the seq of the record that did.
			expect(assistant.anchorSeq).toBe(5);
		});
	});

	// The address a fork cuts at. It has to come from the server, and it has to
	// land on the message the user is looking at — a seq on the wrong message
	// cuts the transcript in the wrong place, silently.
	describe("anchor seqs", () => {
		it("gives each message the seq of the last record folded into it", () => {
			const messages = replayHistory([
				{ type: "message", content: "Hello", seq: 1 },
				{ type: "text", content: "Hi", seq: 2 },
				{ type: "text", content: " there", seq: 3 },
				{ type: "done", seq: 4 },
			]);

			expect(messages).toHaveLength(2);
			// The user message, not the empty placeholder the turn opens with.
			expect((messages[0] as UserMessage).anchorSeq).toBe(1);
			expect((messages[1] as AssistantMessage).anchorSeq).toBe(4);
		});

		it("leaves a message with no seq unaddressable", () => {
			const messages = replayHistory([
				{ type: "message", content: "Hello" },
				{ type: "text", content: "Hi" },
			]);

			expect((messages[0] as UserMessage).anchorSeq).toBeUndefined();
			expect((messages[1] as AssistantMessage).anchorSeq).toBeUndefined();
		});

		// An anchor that ran backwards would put the cut somewhere later than the
		// bubble the user pointed at, keeping messages shown below it.
		it("does not move an earlier message's anchor past a later one", () => {
			const messages = replayHistory([
				{ type: "message", content: "Run it", seq: 1 },
				{
					type: "tool_call",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
					seq: 2,
				},
				{ type: "interrupted", seq: 3 },
				{ type: "message", content: "Never mind", seq: 4 },
				// The interrupted turn's tool finally reports back, into a message
				// that is no longer the last one.
				{
					type: "tool_result",
					tool_use_id: "tool-1",
					tool_result: "file.txt",
					seq: 5,
				},
			]);

			const interrupted = messages.find(
				(m): m is AssistantMessage =>
					m.role === "assistant" && m.status === "interrupted",
			);
			expect(interrupted?.anchorSeq).toBe(3);
		});

		// The message a client sends itself is echoed before the server has a
		// number for it, and the reply carrying that number arrives later — by
		// which time the transcript has moved on. Position cannot find it again:
		// the turn it opened left a placeholder below it, and the agent may have
		// streamed in more.
		it("stamps the message it names, not the last one", () => {
			const before = replayHistory([
				{ type: "message", content: "Hello", seq: 1 },
				{ type: "text", content: "Hi", seq: 2 },
			]);
			const sent = applyUserMessage(before, "Try again");
			const sentId = sent[sent.length - 2].id;

			const after = stampMessageAnchorSeq(sent, sentId, 3);

			expect((after[after.length - 2] as UserMessage).anchorSeq).toBe(3);
			// The placeholder the turn opened is a different record's to claim.
			expect((after[after.length - 1] as AssistantMessage).anchorSeq).toBe(
				undefined,
			);
		});

		// The reply can land after the user has left for another session, whose
		// history the seq names nothing in.
		it("stamps nothing when the message is gone", () => {
			const messages = replayHistory([
				{ type: "message", content: "Elsewhere", seq: 1 },
			]);

			expect(stampMessageAnchorSeq(messages, "not-here", 9)).toBe(messages);
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
			expect(assistant.parts[0]).toMatchObject({
				type: "tool_call",
				tool: {
					id: "tool-1",
					name: "Bash",
					input: { command: "ls" },
					result: "file.txt",
					// Derived, not replayed: a call with a result that says nothing
					// went wrong succeeded.
					status: "success",
				},
			});
			// Nothing this client watched start, so nothing to time.
			expect(
				(assistant.parts[0] as Extract<ContentPart, { type: "tool_call" }>).tool
					.seenAt,
			).toBeUndefined();
		});

		// Turn boundaries survive replay because `done` does. A message is not
		// itself a boundary: here the second one arrives after the ending, which
		// is what closed the bubble above it. One sent *into* a turn gets its
		// bubble from the read point instead ("the read point"), never from the
		// ending — one turn has one ending but any number of bubbles. (What
		// happens when the ending is missing is stated once, in "turn boundaries
		// with a message sent mid-turn".)
		it("splits turns on done rather than on the messages between them", () => {
			const history = [
				{ type: "message", content: "First" },
				{ type: "text", content: "Partial..." },
				{ type: "done" },
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

		it("includes system messages as content parts", () => {
			// The banner's own turn ends before the message: nothing else closes a
			// bubble now, so without the `done` the reply would grow into it.
			const history = [
				{ type: "system", content: "Welcome!" },
				{ type: "done" },
				{ type: "message", content: "Hello" },
				{ type: "text", content: "Hi!" },
				{ type: "done" },
			];
			const messages = replayHistory(history);
			expect(messages).toHaveLength(3);
			// First is an assistant message with the system part (orphan event creates message)
			const systemMsg = messages[0] as AssistantMessage;
			expect(systemMsg.parts).toEqual([
				{ type: "system", content: "Welcome!" },
			]);
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

		it("replays a legacy question with its answered response", () => {
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
				type: "question_record",
				legacy: true,
				status: "answered",
				answer: { answers: ["React"] },
			});
		});

		it("replays the full legacy ask tool sequence as a single part", () => {
			const history = [
				{ type: "message", content: "Help me choose" },
				{
					type: "tool_call",
					tool_name: "AskUserQuestion",
					tool_input: { questions: sampleQuestions },
					tool_use_id: "toolu_q_1",
				},
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
				{
					type: "tool_result",
					tool_use_id: "toolu_q_1",
					tool_result:
						'Your questions have been answered: "Which library?"="React".',
				},
				{ type: "done" },
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts).toHaveLength(1);
			expect(assistant.parts[0]).toMatchObject({
				type: "question_record",
				legacy: true,
				status: "answered",
				answer: { answers: ["React"] },
			});
		});

		it("replays a legacy question with a cancelled response", () => {
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
				type: "question_record",
				legacy: true,
				status: "cancelled",
			});
		});

		// What the server actually persists on cancel: a nil answers map, which
		// `omitempty` then strips from the record.
		it("replays a legacy question as cancelled when the answers key is absent", () => {
			const history = [
				{ type: "message", content: "Help me choose" },
				{
					type: "ask_user_question",
					request_id: "q-1",
					tool_use_id: "toolu_q_1",
					questions: sampleQuestions,
				},
				{ type: "question_response", request_id: "q-1" },
				{ type: "interrupted" },
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "question_record",
				legacy: true,
				status: "cancelled",
			});
		});

		it("keeps a legacy question pending when nothing answered it", () => {
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
				type: "question_record",
				legacy: true,
				status: "pending",
			});
		});

		it("expires pending dialogs via expirePendingDialogs when history lacks process_ended (server restart)", () => {
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
			// Simulate: replay returns pending dialogs (no process_ended in history)
			let messages = replayHistory(history);
			expect((messages[1] as AssistantMessage).parts[0]).toMatchObject({
				type: "permission_request",
				status: "pending",
			});
			// Then expirePendingDialogs is called because process state is "ended"
			messages = expirePendingDialogs(messages);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "expired",
			});
		});

		it("expires pending dialogs on process_ended during replay", () => {
			const history = [
				{ type: "message", content: "Do something" },
				{
					type: "permission_request",
					request_id: "req-1",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
				},
				{ type: "process_ended" },
			];
			const messages = replayHistory(history);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.parts[0]).toMatchObject({
				type: "permission_request",
				status: "expired",
			});
		});

		// Reopening the session must not resurrect the turn the user stopped:
		// history ends on the Task's late output, and the last message's status
		// is what tells the UI whether the agent is still going.
		it("replays a turn interrupted before its Task finished as interrupted", () => {
			const history = [
				{ type: "message", content: "Do something" },
				{ type: "text", content: "Working" },
				{ type: "interrupted" },
				{ type: "text", content: "Task done" },
			];
			const messages = replayHistory(history);
			expect(messages).toHaveLength(2);
			const assistant = messages[1] as AssistantMessage;
			expect(assistant.status).toBe("interrupted");
		});
	});

	// A tool run's status is derived from records the client already has, so a
	// replayed transcript says the same thing a live one did.
	describe("tool runs", () => {
		const streamingRun = (parts: ContentPart[] = []): AssistantMessage => ({
			id: "msg-1",
			role: "assistant",
			parts,
			status: "streaming",
			createdAt: new Date(),
		});

		const call = (toolUseId: string, toolName = "Bash") => ({
			type: "tool_call" as const,
			toolUseId,
			toolName,
			toolInput: { command: "npm run build" },
		});

		const runsOf = (message: Message): ToolRun[] =>
			(message as AssistantMessage).parts
				.filter((part) => part.type === "tool_call")
				.map((part) => part.tool);

		it("starts a call running and settles it from the flag on the wire", () => {
			let messages: Message[] = [streamingRun()];
			messages = applyServerEvent(messages, call("t1"));
			expect(runsOf(messages[0])).toMatchObject([{ status: "running" }]);

			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "t1",
				toolResult: "boom",
				isError: true,
			});
			expect(runsOf(messages[0])).toMatchObject([
				{ status: "error", result: "boom" },
			]);
		});

		it("carries the figures an engine reported about a finished call", () => {
			let messages: Message[] = [streamingRun()];
			messages = applyServerEvent(messages, call("t1"));
			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "t1",
				toolResult: "",
				isError: false,
				durationMs: 4200,
				exitCode: 1,
			});
			expect(runsOf(messages[0])).toMatchObject([
				{ durationMs: 4200, exitCode: 1 },
			]);
		});

		// Claude reports no duration at all, and zero is how that arrives.
		it("treats a reported duration of zero as no duration", () => {
			expect(
				normalizeEvent({
					type: "tool_result",
					tool_use_id: "t1",
					tool_result: "ok",
					duration_ms: 0,
				}),
			).toMatchObject({ durationMs: undefined });
		});

		// A backgrounded call returns a placeholder at once. Without the subtype
		// that placeholder would replay as "this succeeded", which is the exact
		// lie the old UI told.
		it("keeps a backgrounded call running on its placeholder result", () => {
			let messages: Message[] = [streamingRun()];
			messages = applyServerEvent(messages, call("t1"));
			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "t1",
				toolResult: "Command running in background with ID: bash_1",
				isError: false,
				subtype: "background_started",
			});

			expect(runsOf(messages[0])).toMatchObject([
				{
					status: "background",
					fromBackground: true,
					placeholderResult: "Command running in background with ID: bash_1",
				},
			]);
		});

		// The placeholder is what the agent read; the outcome is what happened.
		// A body showing only the second asserts the agent saw something it did
		// not, so both are kept.
		it("settles a background call on its outcome without losing the placeholder", () => {
			let messages: Message[] = [streamingRun()];
			messages = applyServerEvent(messages, call("t1"));
			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "t1",
				toolResult: "Command running in background with ID: bash_1",
				isError: false,
				subtype: "background_started",
			});
			// The conversation carried on above it.
			messages = applyServerEvent(messages, { type: "done" });
			messages = applyServerEvent(messages, {
				type: "message",
				content: "meanwhile",
			});
			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "t1",
				toolResult: "Build succeeded",
				isError: false,
				subtype: "background_result",
			});

			expect(runsOf(messages[0])).toMatchObject([
				{
					status: "success",
					fromBackground: true,
					placeholderResult: "Command running in background with ID: bash_1",
					result: "Build succeeded",
				},
			]);
		});

		// Pockode writes this one itself, after seeing the process that owned the
		// task die. It cannot lean on an earlier `background_started` to mark the
		// run: `task_updated` may turn a call into a background task after its
		// own result was already parsed, and then nothing marked it — yet the
		// row still has to say the outcome came after the turn, not from the
		// agent's own read.
		it("labels a lost background call as backgrounded even with no placeholder", () => {
			let messages: Message[] = [streamingRun()];
			messages = applyServerEvent(messages, call("t1"));
			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "t1",
				toolResult: "started",
				isError: false,
			});
			// The process was killed; the next one settles the row.
			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "t1",
				toolResult: "This background task did not finish",
				isError: true,
				subtype: "background_lost",
			});

			expect(runsOf(messages[0])).toMatchObject([
				{
					status: "error",
					fromBackground: true,
					result: "This background task did not finish",
				},
			]);
		});

		// A record with no id names no call. Matching it against the parts that
		// also have none would rebuild a row for some other call entirely.
		it("drops a result that names no call rather than guessing", () => {
			let messages: Message[] = [streamingRun()];
			messages = applyServerEvent(messages, call("t1"));
			const before = messages;
			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "",
				toolResult: "ok",
				isError: false,
			});

			expect(messages).toBe(before);
		});

		// A turn cut short leaves nothing that can report back on a running call
		// — but background work outlives the turn by definition.
		it("interrupts a running call and leaves a background one alone", () => {
			let messages: Message[] = [streamingRun()];
			messages = applyServerEvent(messages, call("t1"));
			messages = applyServerEvent(messages, call("t2"));
			messages = applyServerEvent(messages, {
				type: "tool_result",
				toolUseId: "t2",
				toolResult: "placeholder",
				isError: false,
				subtype: "background_started",
			});
			messages = applyServerEvent(messages, { type: "interrupted" });

			expect(runsOf(messages[0])).toMatchObject([
				{ id: "t1", status: "interrupted" },
				{ id: "t2", status: "background" },
			]);
		});

		// TaskOutput: a call whose whole job is to read an earlier call's task.
		// The server resolves which call that is (`origin_tool_use_id`) because
		// only the adapter can turn a task id into a tool_use_id.
		describe("a call that fetches an earlier call's output", () => {
			const fetchCall = (toolUseId: string, originToolUseId?: string) => ({
				type: "tool_call" as const,
				toolUseId,
				toolName: "TaskOutput",
				toolInput: { task_id: "bg_1" },
				...(originToolUseId ? { originToolUseId } : {}),
			});

			const backgrounded = (): Message[] => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "t1",
					toolResult: "Running in background with ID: bg_1",
					isError: false,
					subtype: "background_started",
				});
				return messages;
			};

			it("carries the call it reads through normalization", () => {
				expect(
					normalizeEvent({
						type: "tool_call",
						tool_use_id: "f1",
						tool_name: "TaskOutput",
						tool_input: { task_id: "bg_1" },
						origin_tool_use_id: "t1",
					}),
				).toMatchObject({ originToolUseId: "t1" });
			});

			it("files the fetch on the call it reads instead of taking a row", () => {
				let messages = backgrounded();
				messages = applyServerEvent(messages, fetchCall("f1", "t1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "f1",
					toolResult: "tick 418",
					isError: false,
				});

				const run = runsOf(messages[0])[0];
				// Untouched by the fetch: the task is still running, and what this
				// call handed the agent is still the placeholder.
				expect(run).toMatchObject({
					id: "t1",
					status: "background",
					fetches: [{ id: "f1", result: "tick 418" }],
				});
				expect(run.result).toBeUndefined();
			});

			// The common case, not a fallback: the tracker drops a task once it
			// settles, and one a previous process started was never in it.
			it("keeps its own row when the call it reads cannot be named", () => {
				let messages = backgrounded();
				messages = applyServerEvent(messages, fetchCall("f1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "f1",
					toolResult: "tick 418",
					isError: false,
				});

				const runs = runsOf(messages[0]);
				expect(runs).toMatchObject([
					{ id: "t1" },
					{ id: "f1", name: "TaskOutput", status: "success" },
				]);
				expect(runs[0].fetches).toBeUndefined();
			});

			// Nor when the row it names is simply not on this page of history.
			it("keeps its own row when the call it reads is not loaded", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, fetchCall("f1", "t1"));

				expect(runsOf(messages[0])).toMatchObject([{ id: "f1" }]);
			});

			// TaskOutput's semantics do not say whether it returns the whole
			// output or what is new since last time, so neither concatenating the
			// texts nor keeping only the newest can be done without lying. Each
			// fetch stays its own entry.
			it("keeps every fetch of the same task, oldest first", () => {
				let messages = backgrounded();
				for (const [id, text] of [
					["f1", "tick 1"],
					["f2", "tick 207"],
					["f3", "tick 418"],
				]) {
					messages = applyServerEvent(messages, fetchCall(id, "t1"));
					messages = applyServerEvent(messages, {
						type: "tool_result",
						toolUseId: id,
						toolResult: text,
						isError: false,
					});
				}

				expect(runsOf(messages[0])[0].fetches).toEqual([
					{ id: "f1", result: "tick 1" },
					{ id: "f2", result: "tick 207" },
					{ id: "f3", result: "tick 418" },
				]);
			});

			// Some CLIs re-send a call after it was approved, and one announced
			// twice is still one fetch — including after its result has landed,
			// which the second announcement must not wipe.
			it("files a re-sent fetch once, keeping what it already brought back", () => {
				let messages = backgrounded();
				messages = applyServerEvent(messages, fetchCall("f1", "t1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "f1",
					toolResult: "tick 418",
					isError: false,
				});
				messages = applyServerEvent(messages, fetchCall("f1", "t1"));

				expect(runsOf(messages[0])).toMatchObject([{ id: "t1" }]);
				expect(runsOf(messages[0])[0].fetches).toEqual([
					{ id: "f1", result: "tick 418" },
				]);
			});

			// Paging backwards replays every result over each older page it pulls
			// in, so the same record arrives again. Appended blindly it would draw
			// one fetch twice — which is exactly what the rule above must not be
			// confused with.
			it("updates the entry a replayed result already wrote", () => {
				let messages = backgrounded();
				messages = applyServerEvent(messages, fetchCall("f1", "t1"));
				const result = {
					type: "tool_result" as const,
					toolUseId: "f1",
					toolResult: "tick 418",
					isError: false,
				};
				messages = applyServerEvent(messages, result);
				messages = applyServerEvent(messages, result);

				expect(runsOf(messages[0])[0].fetches).toEqual([
					{ id: "f1", result: "tick 418" },
				]);
			});

			// An interrupted turn takes its pending calls down with it, and this
			// one brought nothing back. The entry stays outputless so that a
			// renderer has nothing to draw for it.
			it("leaves a fetch that never returned carrying nothing", () => {
				let messages = backgrounded();
				messages = applyServerEvent(messages, fetchCall("f1", "t1"));
				messages = applyServerEvent(messages, { type: "interrupted" });

				expect(runsOf(messages[0])[0].fetches).toEqual([{ id: "f1" }]);
			});

			// The fetch failed, not the task: the row keeps saying what the task
			// is doing, and only the entry says the read went wrong.
			it("marks a failed fetch without failing the call it reads", () => {
				let messages = backgrounded();
				messages = applyServerEvent(messages, fetchCall("f1", "t1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "f1",
					toolResult: "No such task: bg_1",
					isError: true,
				});

				expect(runsOf(messages[0])).toMatchObject([
					{
						status: "background",
						fetches: [{ id: "f1", isError: true }],
					},
				]);
			});

			// Absorbing the only part of a turn leaves a bubble with nothing in
			// it. Handled in the state layer, by the same rule that drops a turn
			// the agent never wrote into: no renderer has to know about it.
			it("leaves no empty bubble behind when it was the turn's only part", () => {
				let messages = backgrounded();
				messages = applyServerEvent(messages, { type: "done" });
				messages = applyServerEvent(messages, {
					type: "message",
					content: "how is it going",
				});
				messages = applyServerEvent(messages, fetchCall("f1", "t1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "f1",
					toolResult: "tick 418",
					isError: false,
				});
				messages = applyServerEvent(messages, { type: "done" });

				expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
				expect(runsOf(messages[0])[0].fetches).toMatchObject([
					{ result: "tick 418" },
				]);
			});
		});

		describe("live progress", () => {
			const activity = (
				toolUseId: string,
				fields: { activity?: string; outputDelta?: string },
			) => ({ type: "tool_activity" as const, toolUseId, ...fields });

			it("accumulates the deltas into the call's output", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(
					messages,
					activity("t1", { outputDelta: "one\n" }),
				);
				messages = applyServerEvent(
					messages,
					activity("t1", { outputDelta: "two\n" }),
				);
				expect(runsOf(messages[0])).toMatchObject([{ output: "one\ntwo\n" }]);
			});

			// A line that blinks in and out re-flows every row below it.
			it("leaves the last status standing when an update carries none", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(
					messages,
					activity("t1", { activity: "Compiling" }),
				);
				messages = applyServerEvent(
					messages,
					activity("t1", { outputDelta: "x" }),
				);
				expect(runsOf(messages[0])).toMatchObject([{ activity: "Compiling" }]);
			});

			// Updates are coalesced per frame, so one held back may be applied
			// after the result. A progress line under a finished row is worse than
			// a moment of missing liveness.
			it("ignores progress that arrives after the call has settled", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "t1",
					toolResult: "done",
					isError: false,
				});
				messages = applyServerEvent(
					messages,
					activity("t1", { activity: "late" }),
				);
				expect(runsOf(messages[0])[0].activity).toBeUndefined();
			});

			// It belongs to a call that may be several turns above: a background
			// one reports while the conversation carries on.
			it("still reaches a call the conversation has moved past", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "t1",
					toolResult: "placeholder",
					isError: false,
					subtype: "background_started",
				});
				messages = applyServerEvent(messages, { type: "done" });
				messages = applyServerEvent(messages, {
					type: "message",
					content: "meanwhile",
				});
				messages = applyToolActivitySnapshot(messages, {
					t1: "Still building",
				});
				expect(runsOf(messages[0])).toMatchObject([
					{ activity: "Still building" },
				]);
			});

			it("drops progress that names no call on screen", () => {
				const messages: Message[] = [streamingRun()];
				expect(
					applyServerEvent(messages, activity("nobody", { activity: "hi" })),
				).toBe(messages);
			});
		});

		// Only a call this client watched start has an honest clock; a replayed
		// one would otherwise start its stopwatch at page load.
		it("times only the calls this client saw start", () => {
			const live = applyServerEvent([streamingRun()], call("t1"), undefined, {
				live: true,
			});
			expect(runsOf(live[0])[0].seenAt).toBeInstanceOf(Date);

			const replayed = applyServerEvent([streamingRun()], call("t1"));
			expect(runsOf(replayed[0])[0].seenAt).toBeUndefined();
		});

		// An approved command used to draw two rows around its card, because the
		// card was appended beside the pending row instead of taking its place —
		// and with a spinner on that row, it claimed to be running while the user
		// was still deciding. Both announcement orders are covered below: Claude
		// sends the call first, Codex may ask first.
		describe("a call that had to be approved", () => {
			const permission = {
				type: "permission_request" as const,
				requestId: "r1",
				toolName: "Bash",
				toolInput: { command: "rm -rf build" },
				toolUseId: "t1",
			};

			it("lets the card take the pending row's place", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, permission);

				expect((messages[0] as AssistantMessage).parts).toMatchObject([
					{ type: "permission_request", status: "pending" },
				]);
			});

			// Measured against claude 2.1.263: the call is announced before the
			// approval request and is never re-sent, so the card is all that is
			// left of it — and the row has to come back when the engine reports,
			// or the command's output would appear nowhere at all.
			it("gives the row back when the engine reports on an approved call", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, permission);
				messages = applyServerEvent(messages, {
					type: "permission_response",
					requestId: "r1",
					choice: "allow",
				});
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "t1",
					toolResult: "removed",
					isError: false,
				});

				expect((messages[0] as AssistantMessage).parts).toMatchObject([
					{ type: "permission_request", status: "allowed" },
					{
						type: "tool_call",
						tool: {
							id: "t1",
							name: "Bash",
							input: { command: "rm -rf build" },
							status: "success",
							result: "removed",
						},
					},
				]);
			});

			// Codex may ask for approval before it announces the item at all, so
			// the call can arrive *after* its card. Either order draws one row,
			// and not while the user is still deciding.
			it("adds no row for a call whose card is still pending", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, permission);
				messages = applyServerEvent(messages, call("t1"));

				expect((messages[0] as AssistantMessage).parts).toMatchObject([
					{ type: "permission_request", status: "pending" },
				]);
			});

			// The machine is waiting for the user, not working.
			it("keeps progress from spinning a row above a card still pending", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, permission);
				messages = applyServerEvent(messages, {
					type: "tool_activity",
					toolUseId: "t1",
					outputDelta: "working\n",
				});

				expect((messages[0] as AssistantMessage).parts).toMatchObject([
					{ type: "permission_request", status: "pending" },
				]);
			});

			// Once the user has answered, output belongs to a row again.
			it("gives the row back for progress on an approved call", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, permission);
				messages = applyServerEvent(messages, {
					type: "permission_response",
					requestId: "r1",
					choice: "allow",
				});
				messages = applyServerEvent(messages, {
					type: "tool_activity",
					toolUseId: "t1",
					outputDelta: "working\n",
				});

				expect((messages[0] as AssistantMessage).parts).toMatchObject([
					{ type: "permission_request", status: "allowed" },
					{
						type: "tool_call",
						tool: { status: "running", output: "working\n" },
					},
				]);
			});

			// Some CLIs do re-send the call after approval. One row either way.
			it("draws exactly one row when the call is re-sent after approval", () => {
				let messages: Message[] = [streamingRun()];
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, permission);
				messages = applyServerEvent(messages, {
					type: "permission_response",
					requestId: "r1",
					choice: "allow",
				});
				messages = applyServerEvent(messages, call("t1"));
				messages = applyServerEvent(messages, {
					type: "tool_result",
					toolUseId: "t1",
					toolResult: "removed",
					isError: false,
				});

				expect((messages[0] as AssistantMessage).parts).toMatchObject([
					{ type: "permission_request", status: "allowed" },
					{ type: "tool_call", tool: { id: "t1", status: "success" } },
				]);
			});
		});
	});

	// A subagent call is a tool run like any other; these cover it because it is
	// the call most likely to outlive the turn that started it.
	describe("subagent calls", () => {
		const streaming = (parts: ContentPart[] = []): AssistantMessage => ({
			id: "msg-1",
			role: "assistant",
			parts,
			status: "streaming",
			createdAt: new Date(),
		});

		const taskCall = (
			toolUseId: string,
			description: string,
			subagentType = "Explore",
			toolName = "Agent",
		) => ({
			type: "tool_call" as const,
			toolUseId,
			toolName,
			toolInput: { description, subagent_type: subagentType, prompt: "go" },
		});

		const taskResult = (
			toolUseId: string,
			toolResult: string,
			isError = false,
		) => ({ type: "tool_result" as const, toolUseId, toolResult, isError });

		const tasksOf = (message: Message): ToolRun[] =>
			(message as AssistantMessage).parts
				.filter((part) => part.type === "tool_call")
				.map((part) => part.tool);

		// Each Task is its own part, sitting where the turn spawned it, so the
		// text written between two of them stays between them.
		it("gives every Task its own part at the point it was called", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("t1", "find usages"));
			messages = applyServerEvent(messages, { type: "text", content: "next" });
			messages = applyServerEvent(messages, taskCall("t2", "write plan"));

			expect((messages[0] as AssistantMessage).parts).toMatchObject([
				{ type: "tool_call", tool: { id: "t1", status: "running" } },
				{ type: "text", content: "next" },
				{ type: "tool_call", tool: { id: "t2", status: "running" } },
			]);
		});

		// Older CLIs named the subagent tool "Task"; stored history still holds
		// that name and has to render the same way.
		it("recognizes the legacy Task tool name alongside Agent", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(
				messages,
				taskCall("t1", "old name", "Explore", "Task"),
			);
			messages = applyServerEvent(messages, taskCall("t2", "new name"));
			expect(tasksOf(messages[0])).toHaveLength(2);
		});

		it("keeps a resent tool_call from duplicating or resetting the Task", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("t1", "find usages"));
			messages = applyServerEvent(messages, taskResult("t1", "report"));
			messages = applyServerEvent(messages, taskCall("t1", "find usages"));

			expect(tasksOf(messages[0])).toMatchObject([
				{ id: "t1", status: "success", result: "report" },
			]);
		});

		it("settles only the Task its result names", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("t1", "first"));
			messages = applyServerEvent(messages, taskCall("t2", "second"));
			messages = applyServerEvent(messages, taskResult("t2", "second report"));

			expect(tasksOf(messages[0])).toMatchObject([
				{ id: "t1", status: "running" },
				{ id: "t2", status: "success", result: "second report" },
			]);
		});

		it("marks a Task the CLI flagged as an error failed", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("t1", "first"));
			messages = applyServerEvent(
				messages,
				taskResult("t1", "Agent type not found", true),
			);

			expect(tasksOf(messages[0])).toMatchObject([
				{ id: "t1", status: "error", result: "Agent type not found" },
			]);
		});

		// An interrupt is a fact about what the user did; the result that shows up
		// afterwards is kept, but it cannot make the UI claim the Task finished.
		it("keeps an interrupted Task interrupted when its result arrives late", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("t1", "first"));
			messages = applyServerEvent(messages, { type: "interrupted" });
			expect(tasksOf(messages[0])).toMatchObject([{ status: "interrupted" }]);

			messages = applyServerEvent(messages, taskResult("t1", "late report"));
			// The content is kept and the status is not: a run that is interrupted
			// and has a result is exactly the "it came back late" case, so no flag
			// has to be kept in step with the two fields that already say it.
			expect(tasksOf(messages[0])).toMatchObject([
				{ status: "interrupted", result: "late report" },
			]);
		});

		it("settles a running Task when the turn ends in an error", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("t1", "first"));
			messages = applyServerEvent(messages, { type: "error", error: "boom" });

			expect(tasksOf(messages[0])).toMatchObject([{ status: "interrupted" }]);
		});

		// The CLI keeps talking for a moment after a turn is cut short, and that
		// can include a whole Task call. Born running inside a turn that already
		// ended, it would spin forever: nothing is left to deliver its result.
		it("never adds a running Task to a turn that already ended", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, { type: "interrupted" });
			messages = applyServerEvent(messages, taskCall("late", "trailing"));

			const assistant = messages[0] as AssistantMessage;
			expect(assistant.status).toBe("interrupted");
			expect(tasksOf(messages[0])).toMatchObject([
				{ id: "late", status: "interrupted" },
			]);
		});

		// A background Task reports back in a later turn, so a turn ending
		// normally must leave it alone.
		it("leaves a Task running when the turn merely completes", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("t1", "background"));
			messages = applyServerEvent(messages, { type: "done" });

			expect(tasksOf(messages[0])).toMatchObject([{ status: "running" }]);

			messages = applyServerEvent(messages, taskResult("t1", "report"));
			expect(tasksOf(messages[0])).toMatchObject([
				{ status: "success", result: "report" },
			]);
		});

		// The whole reason `complete` cannot settle a Task: a background one
		// reports back turns later, and its result has to find the turn it was
		// started in rather than the turn that happens to be open.
		it("lands a background Task's result back in the turn that started it", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("bg", "background"));
			messages = applyServerEvent(messages, { type: "done" });
			messages = applyServerEvent(messages, {
				type: "message",
				content: "meanwhile",
			});
			messages = applyServerEvent(messages, taskCall("t2", "foreground"));
			messages = applyServerEvent(
				messages,
				taskResult("bg", "background report"),
			);

			expect(tasksOf(messages[0])).toMatchObject([
				{ id: "bg", status: "success", result: "background report" },
			]);
			const last = messages[messages.length - 1] as AssistantMessage;
			expect(tasksOf(last)).toMatchObject([{ id: "t2", status: "running" }]);
		});

		it("settles Tasks still running in older turns when the process ends", () => {
			const stale: AssistantMessage = {
				id: "msg-0",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "old",
							name: "Agent",
							input: { description: "stale" },
							status: "running",
						},
					},
				],
				status: "complete",
				createdAt: new Date(),
			};
			const messages = applyServerEvent(
				[stale, streaming([{ type: "text", content: "hi" }])],
				{ type: "process_ended" },
			);

			expect(tasksOf(messages[0])).toMatchObject([{ status: "interrupted" }]);
		});

		it("keeps the next turn's Task in the next turn", () => {
			let messages: Message[] = [streaming()];
			messages = applyServerEvent(messages, taskCall("t1", "first"));
			messages = applyServerEvent(messages, { type: "done" });
			messages = applyServerEvent(messages, {
				type: "message",
				content: "next",
			});
			messages = applyServerEvent(messages, taskCall("t2", "second"));

			const last = messages[messages.length - 1] as AssistantMessage;
			expect(tasksOf(last)).toMatchObject([{ id: "t2" }]);
			expect(tasksOf(messages[0])).toMatchObject([{ id: "t1" }]);
		});

		// Replay is the same path, so a history that ends mid-Task replays as a
		// running Task. The caller settles it only when the process is known to
		// be gone — see useChatMessages.
		it("replays an unfinished Task as running until it is settled", () => {
			const history = [
				{ type: "message", content: "Do something" },
				{
					type: "tool_call",
					tool_use_id: "t1",
					tool_name: "Agent",
					tool_input: { description: "explore", subagent_type: "Explore" },
				},
			];
			const replayed = replayHistory(history);
			expect(tasksOf(replayed[replayed.length - 1])).toMatchObject([
				{ status: "running" },
			]);

			const settled = settleRunningToolRuns(replayed);
			expect(tasksOf(settled[settled.length - 1])).toMatchObject([
				{ status: "interrupted" },
			]);
		});

		it("carries a Task's report through history replay", () => {
			const history = [
				{ type: "message", content: "Do something" },
				{
					type: "tool_call",
					tool_use_id: "t1",
					tool_name: "Agent",
					tool_input: { description: "explore", subagent_type: "Explore" },
				},
				{ type: "tool_result", tool_use_id: "t1", tool_result: "# Report" },
				{ type: "done" },
			];
			const replayed = replayHistory(history);
			expect(tasksOf(replayed[replayed.length - 1])).toMatchObject([
				{ status: "success", result: "# Report" },
			]);
		});
	});

	describe("paging backwards through history", () => {
		describe("isBackReference", () => {
			it("picks out the records that settle something recorded earlier", () => {
				expect(isBackReference({ type: "tool_result" })).toBe(true);
				expect(isBackReference({ type: "question_response" })).toBe(true);
				expect(isBackReference({ type: "process_ended" })).toBe(true);
				expect(isBackReference({ type: "text", content: "hi" })).toBe(false);
				expect(isBackReference({ type: "message", content: "hi" })).toBe(false);
			});
		});

		describe("catching an older page up on what it could not know", () => {
			it("finishes a call whose result only arrived a page later", () => {
				const older = replayHistory([
					{ type: "message", content: "Read it" },
					{ type: "tool_call", tool_use_id: "t1", tool_name: "Read" },
				]);
				expect(partsOf(older[older.length - 1])).not.toMatchObject([
					{ type: "tool_call", tool: { result: "file body" } },
				]);

				const caught = prependHistoryPage(older, [], {
					backReferences: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							tool_result: "file body",
						},
					],
				});
				expect(partsOf(caught[caught.length - 1])).toMatchObject([
					{ type: "tool_call", tool: { result: "file body" } },
				]);
			});

			// Same path for a Task, whose report is the whole of what it has to
			// say: closing the older page's turn leaves it running, so the
			// back-reference is the only thing that can finish it.
			it("finishes a Task whose report only arrived a page later", () => {
				const older = replayHistory([
					{ type: "message", content: "Explore" },
					{
						type: "tool_call",
						tool_use_id: "t1",
						tool_name: "Agent",
						tool_input: { description: "find usages" },
					},
				]);

				const caught = prependHistoryPage(older, [], {
					backReferences: [
						{ type: "tool_result", tool_use_id: "t1", tool_result: "# Report" },
					],
				});
				expect(partsOf(caught[caught.length - 1])).toMatchObject([
					{ type: "tool_call", tool: { status: "success" } },
				]);
			});

			// §2.1: which side of the join a fetch lands on is decided when its
			// call arrives and never revisited. Paging backwards can bring the
			// call it reads into view long afterwards, and the row that is
			// already drawn does not then go and move — the transcript's one
			// unbreakable rule is that nothing vanishes from under the reader.
			it("leaves a fetch that already drew its own row where it is", () => {
				const fetchResult = {
					type: "tool_result",
					tool_use_id: "f1",
					tool_result: "tick 418",
				};
				// Replayed on its own, this page could not name the call it reads.
				const current = replayHistory([
					{
						type: "tool_call",
						tool_use_id: "f1",
						tool_name: "TaskOutput",
						tool_input: { task_id: "bg_1" },
						origin_tool_use_id: "t1",
					},
					fetchResult,
				]);

				const older = replayHistory([
					{ type: "message", content: "run it in the background" },
					{ type: "tool_call", tool_use_id: "t1", tool_name: "Bash" },
					{
						type: "tool_result",
						tool_use_id: "t1",
						tool_result: "Running in background with ID: bg_1",
						subtype: "background_started",
					},
				]);

				const paged = prependHistoryPage(older, current, {
					backReferences: [fetchResult],
				});

				const runs = paged.flatMap((message) =>
					partsOf(message)
						.filter((part) => part.type === "tool_call")
						.map((part) => part.tool),
				);
				expect(runs).toMatchObject([
					{ id: "t1", status: "background" },
					{ id: "f1", status: "success", result: "tick 418" },
				]);
				// And the older page's run did not quietly acquire it either: the
				// result replayed over that page names a fetch it never filed.
				expect(runs[0].fetches).toBeUndefined();
			});

			it("retires a legacy question the user had already answered", () => {
				const older = replayHistory([
					{
						type: "ask_user_question",
						request_id: "q1",
						tool_use_id: "t1",
						questions: sampleQuestions,
					},
				]);

				const caught = prependHistoryPage(older, [], {
					backReferences: [
						{
							type: "question_response",
							request_id: "q1",
							answers: { Library: "React" },
						},
					],
				});
				expect(partsOf(caught[caught.length - 1])).toMatchObject([
					{ type: "question_record", status: "answered" },
				]);
			});

			it("retires what a later process end left open without claiming the turn ended there", () => {
				// The process died long after this page. The request it stranded has
				// to be retired, but the turn itself was still running at this point
				// and did not end that way.
				const older = replayHistory([
					{ type: "message", content: "Do it" },
					{
						type: "permission_request",
						request_id: "p1",
						tool_name: "Bash",
						tool_use_id: "t1",
					},
					{ type: "text", content: "half an answer" },
				]);

				const caught = prependHistoryPage(older, [], {
					backReferences: [{ type: "process_ended" }],
				});

				const turn = caught[caught.length - 1];
				expect(turn).toMatchObject({ status: "complete" });
				expect(partsOf(turn)).toMatchObject([
					{ type: "permission_request", status: "expired" },
					{ type: "text" },
				]);
			});
			it("retires what a killed process left open, which this page never recorded", () => {
				// The process is gone and nothing in this page says so — the
				// process_ended a restart repair writes lands at the end of the
				// transcript, pages further back learn nothing from it.
				const older = replayHistory([
					{ type: "message", content: "Do it" },
					{
						type: "permission_request",
						request_id: "p1",
						tool_name: "Bash",
						tool_use_id: "t1",
					},
				]);

				const caught = prependHistoryPage(older, [], {
					turn: { phase: "idle", open: false, since: "" },
				});

				expect(partsOf(caught[caught.length - 1])).toMatchObject([
					{ type: "permission_request", status: "expired" },
				]);
			});
		});

		describe("prependHistoryPage", () => {
			it("rejoins the turn the page boundary cut in half", () => {
				// The cut falls between two records of one answer: the older page trails
				// off mid-sentence, and the page above it opens on content that no
				// message event preceded.
				const older = replayHistory([
					{ type: "message", content: "Explain" },
					{ type: "text", content: "first half " },
				]);
				const current = replayHistory([
					{ type: "text", content: "second half" },
					{ type: "done" },
				]);

				const joined = prependHistoryPage(older, current);

				expect(joined.map((m) => m.role)).toEqual(["user", "assistant"]);
				expect(partsOf(joined[1])).toMatchObject([
					{ type: "text", content: "first half second half" },
				]);
				// The bubble already on screen keeps its identity, so it is not remounted
				// and whatever was expanded inside it survives.
				expect(joined[1].id).toBe(current[0].id);
			});

			it("leaves a turn of its own alone", () => {
				const older = replayHistory([
					{ type: "message", content: "Earlier" },
					{ type: "text", content: "answer" },
					{ type: "done" },
				]);
				const current = replayHistory([
					{ type: "message", content: "Later" },
					{ type: "text", content: "reply" },
					{ type: "done" },
				]);

				const joined = prependHistoryPage(older, current);
				expect(joined.map((m) => m.role)).toEqual([
					"user",
					"assistant",
					"user",
					"assistant",
				]);
			});

			it("keeps work events on either side of a page boundary in order", () => {
				const workMeta = {
					work_id: "w1",
					work_type: "task",
					title: "Ship it",
				};
				const older = replayHistory([
					{
						type: "message",
						content: "Kickoff",
						origin: "system",
						subtype: "kickoff",
						meta: workMeta,
					},
					{ type: "text", content: "starting" },
					{ type: "done" },
				]);
				const current = replayHistory([
					{
						type: "message",
						content: "Auto-continue",
						origin: "system",
						subtype: "auto_continue",
						meta: workMeta,
					},
				]);

				const joined = prependHistoryPage(older, current);

				// Ordinary messages, so paging needs no special case: each stays
				// where it was recorded instead of being pulled up into a card.
				expect(
					joined
						.filter((m) => m.role === "user")
						.map((m) => (m as UserMessage).subtype),
				).toEqual(["kickoff", "auto_continue"]);
			});

			it("keeps both halves' Tasks when a turn spans the boundary", () => {
				const older = replayHistory([
					{ type: "message", content: "Explore" },
					{
						type: "tool_call",
						tool_use_id: "t1",
						tool_name: "Task",
						tool_input: { description: "first" },
					},
				]);
				const current = replayHistory([
					{
						type: "tool_call",
						tool_use_id: "t2",
						tool_name: "Task",
						tool_input: { description: "second" },
					},
				]);

				const joined = prependHistoryPage(older, current);

				expect(partsOf(joined[joined.length - 1])).toMatchObject([
					{ type: "tool_call", tool: { id: "t1" } },
					{ type: "tool_call", tool: { id: "t2" } },
				]);
			});

			it("stops the spinner on a turn whose ending is in the page above", () => {
				// Replayed alone the page ends on a streaming bubble, because the record
				// that closed the turn is not in it.
				const older = replayHistory([
					{ type: "message", content: "Explain" },
					{ type: "text", content: "half an answer" },
				]);
				expect(older[older.length - 1]).toMatchObject({ status: "streaming" });

				const joined = prependHistoryPage(older, []);
				expect(joined[joined.length - 1]).toMatchObject({ status: "complete" });
			});

			it("keeps how a turn ended when the record saying so opens the page above", () => {
				// That record has nothing to end in its own page, so replaying that page
				// drops it. Without it the turn reads as a normal finished answer.
				const older = replayHistory([
					{ type: "message", content: "Explain", seq: 1 },
					{ type: "text", content: "half an answer", seq: 2 },
					{
						type: "tool_call",
						tool_use_id: "t1",
						tool_name: "Task",
						tool_input: { description: "sub" },
						seq: 3,
					},
				]);
				const boundaryTerminal = { type: "error", error: "boom", seq: 4 };
				const current = replayHistory([
					boundaryTerminal,
					{ type: "message", content: "Next", seq: 5 },
				]);

				const joined = prependHistoryPage(older, current, {
					boundaryTerminal,
				});

				const turn = joined[1];
				expect(turn).toMatchObject({ status: "error", error: "boom" });
				// The record that ended the turn is the last one in it, so it is where
				// a fork of the turn cuts — the address an unbroken replay leaves here.
				expect(turn).toMatchObject({ anchorSeq: 4 });
				// A turn that ended this way has no Task left running.
				expect(partsOf(turn)).toMatchObject([
					{ type: "text" },
					{ type: "tool_call", tool: { status: "interrupted" } },
				]);
			});

			it("does not let output trailing an ended turn reopen it", () => {
				// The CLI was still writing when the turn was cut short, so the page
				// above opens on content that belongs to the turn that already ended.
				const older = replayHistory([
					{ type: "message", content: "Explain" },
					{ type: "text", content: "half " },
					{ type: "interrupted" },
				]);
				const current = replayHistory([{ type: "text", content: "an answer" }]);

				const joined = prependHistoryPage(older, current);

				const turn = joined[joined.length - 1];
				expect(turn).toMatchObject({ status: "interrupted" });
				expect(partsOf(turn)).toMatchObject([
					{ type: "text", content: "half an answer" },
				]);
			});
		});
	});
});
