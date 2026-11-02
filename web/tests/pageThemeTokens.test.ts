import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_THEME_VARS } from "../src/lib/pageTheme";

// The `--pk-*` names are told to the agent by `html_render`'s and
// `html_edit`'s descriptions on the server, and only a page that uses one of
// them exactly follows the theme (`followsTheme`). A name added, renamed or
// dropped on one side and not the other fails nowhere else: the agent writes
// a variable the page never gets, or never hears of one it could use, and
// the page is drawn white or with its colours undefined.
describe("the page theme's variables", () => {
	it("are the ones the tool descriptions tell the agent", () => {
		const tools = readFileSync(
			resolve(__dirname, "../../server/mcp/tools.go"),
			"utf8",
		);
		const told = new Set(tools.match(/--pk-[a-z][a-z-]*[a-z]/g) ?? []);
		expect([...told].sort()).toEqual([...PAGE_THEME_VARS].sort());
	});
});
