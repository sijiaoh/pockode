import { describe, expect, it } from "vitest";
import { pageBridgeScript } from "./pageBridge";

describe("pageBridgeScript", () => {
	// Inlined into a `<script>` of a `srcdoc`: a `</` would end it there, and
	// each part is put together without the others in some page.
	it.each([
		{ sends: true, themed: false },
		{ sends: false, themed: true },
		{ sends: true, themed: true },
	])("is one script that parses, with no `</` inside, for %o", (parts) => {
		const markup = pageBridgeScript("parent.parent", parts);
		const body = markup.slice("<script>".length, -"</script>".length);
		expect(markup.startsWith("<script>")).toBe(true);
		expect(body).not.toContain("</");
		expect(() => new Function(body)).not.toThrow();
	});
});
