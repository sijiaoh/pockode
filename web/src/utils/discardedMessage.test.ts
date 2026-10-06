import { describe, expect, it } from "vitest";
import type { UserMessage } from "../types/message";
import {
	commandRestoreBlocked,
	type Draft,
	isInDraft,
	restoreIntoDraft,
	turnRestore,
} from "./discardedMessage";

function message(overrides: Partial<UserMessage> = {}): UserMessage {
	return {
		id: "row",
		role: "user",
		content: "Do X instead",
		status: "complete",
		createdAt: new Date(0),
		...overrides,
	};
}

function draft(text = "", attachmentIds: string[] = []): Draft {
	return {
		text,
		attachmentIds,
		isEmpty: text.trim() === "" && attachmentIds.length === 0,
	};
}

const photo = { name: "a.png", mime: "image/png", attachment_id: "file-a" };

describe("restoreIntoDraft", () => {
	it("joins several messages in the order they were sent, files included", () => {
		const restored = restoreIntoDraft(draft(), [
			message({ content: "First" }),
			message({ content: "Second", attachments: [photo] }),
		]);
		expect(restored).toEqual({
			text: "First\n\nSecond",
			attachments: [photo],
		});
	});

	// After a reload the text survives in the draft and the files do not, so a
	// second press must bring back the files without a second copy of the text.
	it("adds only what the draft is missing", () => {
		const restored = restoreIntoDraft(draft("Before\n\nDo X instead"), [
			message({ attachments: [photo] }),
		]);
		expect(restored).toEqual({ attachments: [photo] });
		expect(
			restoreIntoDraft(draft("Do X instead", ["file-a"]), [
				message({ attachments: [photo] }),
			]),
		).toEqual({ attachments: [] });
	});

	it("replaces a draft that is only whitespace", () => {
		expect(restoreIntoDraft(draft("  \n"), [message()]).text).toBe(
			"Do X instead",
		);
		// Not empty — a file is attached — but still no words to keep a line
		// apart from.
		expect(restoreIntoDraft(draft("  \n", ["file-b"]), [message()]).text).toBe(
			"Do X instead",
		);
	});

	it("brings a command back as the user typed it", () => {
		expect(
			restoreIntoDraft(draft(), [
				message({
					content: "expanded prompt",
					command: { name: "pockode-lead", args: "now" },
				}),
			]).text,
		).toBe("/pockode-lead now");
	});
});

describe("isInDraft", () => {
	it("needs the text and every file", () => {
		const withPhoto = message({ attachments: [photo] });
		expect(isInDraft(withPhoto, draft("x Do X instead"))).toBe(false);
		expect(isInDraft(withPhoto, draft("x Do X instead", ["file-a"]))).toBe(
			true,
		);
	});
});

describe("commandRestoreBlocked", () => {
	const command = message({ command: { name: "pockode-lead" } });

	it("blocks a command only behind a draft it is not already in", () => {
		expect(commandRestoreBlocked(command, draft())).toBeUndefined();
		expect(commandRestoreBlocked(command, draft("words"))).toBeDefined();
		expect(commandRestoreBlocked(command, draft("/pockode-lead"))).toBe(
			undefined,
		);
		expect(commandRestoreBlocked(message(), draft("words"))).toBeUndefined();
	});
});

describe("turnRestore", () => {
	const plain = message({ messageId: "p" });
	const command = message({
		messageId: "c",
		command: { name: "pockode-lead" },
	});
	const answer = message({
		messageId: "a",
		answering: [{ request_id: "q", answers: ["Yes"], answered_at: "" }],
	});

	it("offers the plain messages and leaves commands to their menus", () => {
		const restore = turnRestore(
			["p", "c", "a", "gone"],
			new Map([
				["p", plain],
				["c", command],
				["a", answer],
				["gone", undefined],
			]),
		);
		expect(restore).toEqual({
			messages: [plain],
			leavesCommands: true,
			notLoaded: 1,
		});
	});

	it("offers a command when it is the only thing to restore", () => {
		expect(turnRestore(["c"], new Map([["c", command]]))).toEqual({
			messages: [command],
			leavesCommands: false,
			notLoaded: 0,
		});
	});

	// Its text is the answers flattened for the agent, not what the user typed.
	it("offers nothing for an answer to posted questions", () => {
		expect(turnRestore(["a"], new Map([["a", answer]])).messages).toEqual([]);
	});
});
