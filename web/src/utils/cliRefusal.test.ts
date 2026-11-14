import { describe, expect, it } from "vitest";
import type { AssistantMessage, ContentPart } from "../types/message";
import {
	failedOnRefusal,
	isRepeatedByEnding,
	refusalAccounts,
	refusalNotice,
} from "./cliRefusal";

const auth: ContentPart = {
	id: "auth",
	type: "warning",
	message: "401",
	code: "stream_error",
	authFailure: { agent: "claude", profileId: "" },
};
const limit: ContentPart = {
	id: "limit",
	type: "warning",
	message: "You've hit your limit",
	code: "rate_limit",
	usageLimit: { agent: "claude", profileId: "" },
};
const text: ContentPart = { id: "t", type: "text", content: "hi" };

function turn(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		id: "a1",
		role: "assistant",
		parts: [],
		status: "complete",
		createdAt: new Date(),
		...overrides,
	};
}

describe("refusalNotice", () => {
	it("puts the notice on a marked ending, hiding only retries of its kind", () => {
		const message = turn({
			parts: [auth, limit],
			status: "error",
			error: "Not logged in",
			authFailure: { agent: "claude", profileId: "" },
		});
		expect(refusalNotice(message, false)).toEqual({
			refusal: { kind: "auth", agent: "claude", profileId: "" },
		});
		expect(isRepeatedByEnding(message, auth)).toBe(true);
		expect(isRepeatedByEnding(message, limit)).toBe(false);
	});

	it("puts it on the latest marked retry of a running turn, of either kind", () => {
		const message = turn({ parts: [limit, auth, text], status: "streaming" });
		expect(refusalNotice(message, true)?.partIndex).toBe(1);
	});

	// Claude marks the limit on the warning, not on the ending after it.
	it("keeps a usage limit's notice on its warning after an unmarked failure", () => {
		const message = turn({
			parts: [limit, auth],
			status: "error",
			error: "exited",
		});
		expect(refusalNotice(message, false)).toEqual({
			refusal: { kind: "usage_limit", agent: "claude", profileId: "" },
			partIndex: 0,
		});
		expect(isRepeatedByEnding(message, limit)).toBe(false);
	});

	it("draws none for a turn that got past its refusals", () => {
		expect(
			refusalNotice(turn({ parts: [auth, limit] }), false),
		).toBeUndefined();
	});
});

describe("failedOnRefusal", () => {
	it("is a marked ending, or Claude's usage limit before an unmarked one", () => {
		expect(
			failedOnRefusal(
				turn({
					status: "error",
					usageLimit: { agent: "codex", profileId: "" },
				}),
			),
		).toBe(true);
		expect(failedOnRefusal(turn({ status: "error", parts: [limit] }))).toBe(
			true,
		);
		// The auth retry was got past; something else ended the turn.
		expect(failedOnRefusal(turn({ status: "error", parts: [auth] }))).toBe(
			false,
		);
		expect(failedOnRefusal(turn({ parts: [limit] }))).toBe(false);
	});
});

describe("refusalAccounts", () => {
	it("names each marked account once, from anywhere in the transcript", () => {
		expect(refusalAccounts([turn({ parts: [text] })])).toEqual([]);
		expect(
			refusalAccounts([
				turn({ parts: [text, limit] }),
				turn({
					status: "error",
					parts: [auth],
					authFailure: { agent: "claude", profileId: "p1" },
				}),
				turn({ status: "error", authFailure: { agent: "codex" } }),
			]),
		).toEqual([
			{ agent: "claude", profileId: "" },
			{ agent: "claude", profileId: "p1" },
			{ agent: "codex", profileId: undefined },
		]);
	});
});
