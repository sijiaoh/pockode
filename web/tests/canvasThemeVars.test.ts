import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANVAS_THEME_TOKENS } from "../src/lib/canvasBridge";

// The `--pk-*` variables are promised to the agent in one place it reads:
// `canvas_render`'s description. Add a variable to the bridge and forget the
// description, and no agent ever learns of it; map one to a token the app does
// not define, and the page gets no value for it while the computed theme
// simply omits the name — neither fails anything else.

const TOOLS_GO = resolve(import.meta.dirname, "../../server/mcp/tools.go");
const INDEX_CSS = resolve(import.meta.dirname, "../src/index.css");

describe("the canvas theme variables", () => {
	it("are the ones canvas_render's description lists", () => {
		const line = readFileSync(TOOLS_GO, "utf8")
			.split("\n")
			.find((l) => l.includes("Pockode adds only theme colours"));
		expect(line).toBeDefined();
		const listed = line?.match(/--pk-[\w-]+/g) ?? [];

		expect(listed.toSorted()).toEqual(
			Object.keys(CANVAS_THEME_TOKENS).toSorted(),
		);
	});

	it("each come from a token the app's stylesheet defines", () => {
		const css = readFileSync(INDEX_CSS, "utf8");
		const undefinedTokens = Object.values(CANVAS_THEME_TOKENS).filter(
			(token) => !new RegExp(`(?:^|[^-\\w])${token}\\s*:`, "m").test(css),
		);

		expect(undefinedTokens).toEqual([]);
	});
});
