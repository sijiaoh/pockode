import { describe, expect, it } from "vitest";
import { parsePockodeCommand } from "./pockodeCommand";

describe("parsePockodeCommand", () => {
	// The same split the server makes, so the echo shows what the reply will.
	it.each([
		["/pockode-lead", { name: "pockode-lead" }],
		["/pockode-lead   ", { name: "pockode-lead" }],
		["/pockode-lead do X", { name: "pockode-lead", args: "do X" }],
		[
			"/pockode-lead\nline 1\nline 2\n",
			{ name: "pockode-lead", args: "line 1\nline 2" },
		],
		// Unknown names are still Pockode's: the server refuses them.
		["/pockode-foo", { name: "pockode-foo" }],
		// Where JS whitespace and Go's unicode.IsSpace disagree.
		["/pockode-lead\u0085x\u0085", { name: "pockode-lead", args: "x" }],
		["/pockode-lead\ufeffx", { name: "pockode-lead\ufeffx" }],
		["/pockode-lead \ufeffx", { name: "pockode-lead", args: "\ufeffx" }],
	])("parses %j", (content, expected) => {
		expect(parsePockodeCommand(content)).toEqual(expected);
	});

	it.each([
		"/compact",
		"hello /pockode-lead",
		" /pockode-lead",
		"/pockode",
	])("leaves %j alone", (content) => {
		expect(parsePockodeCommand(content)).toBeNull();
	});
});
