import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TURN_AWAITING_ANSWER_MARKER } from "../src/components/Chat/AnswerSheet";

/**
 * One refusal the answer sheet restates in its own words, and the one string it
 * recognises that refusal by.
 *
 * A session held open by a permission request reads nothing else, so an answer
 * sent into it is refused with `chat.ErrTurnAwaitingAnswer`. That sentence is
 * written for the person sitting in that session — "answer it, or stop the
 * turn, then send" — and the sheet replaces it with one that says where to go
 * instead. The match is on text, because the error crosses the wire as a
 * JSON-RPC message and carries nothing else to match on.
 *
 * So the coupling is checked here rather than left to be discovered: reword the
 * Go error and nothing else fails, the sheet silently stops recognising it, and
 * the user is shown a sentence aimed at a card that is not in front of them.
 * The same reason `activityRule.test.ts` reads the server's table.
 */
const CLIENT_GO = resolve(import.meta.dirname, "../../server/chat/client.go");

describe("the refusal the answer sheet restates", () => {
	it("is still worded the way the sheet recognises it", () => {
		const source = readFileSync(CLIENT_GO, "utf8");
		const declaration = source
			.split("\n")
			.find((line) => line.includes("ErrTurnAwaitingAnswer = errors.New("));

		expect(declaration).toBeDefined();
		expect(declaration).toContain(TURN_AWAITING_ANSWER_MARKER);
	});
});
