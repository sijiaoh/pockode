import { describe, expect, it } from "vitest";
import type {
	AskUserQuestionRequest,
	Message,
	QuestionStatus,
} from "../types/message";
import { findPendingQuestions } from "./pendingQuestions";

function request(requestId: string): AskUserQuestionRequest {
	return {
		requestId,
		toolUseId: `tool-${requestId}`,
		questions: [
			{
				question: "Which one?",
				header: "Pick",
				options: [{ label: "A", description: "a" }],
				multiSelect: false,
			},
		],
	};
}

function questionMessage(
	id: string,
	entries: { requestId: string; status: QuestionStatus }[],
): Message {
	return {
		id,
		role: "assistant",
		status: "complete",
		createdAt: new Date(),
		parts: entries.map(({ requestId, status }) => ({
			type: "ask_user_question",
			request: request(requestId),
			status,
		})),
	};
}

function textMessage(id: string): Message {
	return {
		id,
		role: "assistant",
		status: "complete",
		createdAt: new Date(),
		parts: [{ type: "text", content: "hello" }],
	};
}

describe("findPendingQuestions", () => {
	it("returns nothing when there are no questions", () => {
		expect(findPendingQuestions([textMessage("m1")])).toEqual([]);
	});

	it("finds a single pending question", () => {
		const messages = [
			textMessage("m1"),
			questionMessage("m2", [{ requestId: "r1", status: "pending" }]),
		];
		expect(findPendingQuestions(messages)).toEqual([
			{ messageIndex: 1, requestId: "r1" },
		]);
	});

	it("keeps message order across multiple pending questions", () => {
		const messages = [
			questionMessage("m1", [{ requestId: "r1", status: "pending" }]),
			textMessage("m2"),
			questionMessage("m3", [
				{ requestId: "r2", status: "pending" },
				{ requestId: "r3", status: "pending" },
			]),
		];
		expect(findPendingQuestions(messages)).toEqual([
			{ messageIndex: 0, requestId: "r1" },
			{ messageIndex: 2, requestId: "r2" },
			{ messageIndex: 2, requestId: "r3" },
		]);
	});

	it("excludes questions that are no longer pending", () => {
		const messages = [
			questionMessage("m1", [
				{ requestId: "r1", status: "answered" },
				{ requestId: "r2", status: "cancelled" },
				{ requestId: "r3", status: "expired" },
				{ requestId: "r4", status: "pending" },
			]),
		];
		expect(findPendingQuestions(messages)).toEqual([
			{ messageIndex: 0, requestId: "r4" },
		]);
	});
});
