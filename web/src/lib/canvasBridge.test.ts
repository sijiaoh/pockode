import { describe, expect, it } from "vitest";
import { canvasBridgeScript, readCanvasPageMessage } from "./canvasBridge";

describe("canvasBridgeScript", () => {
	const body = canvasBridgeScript("parent.parent").slice(
		"<script>".length,
		-"</script>".length,
	);

	it("is a script that parses", () => {
		// A template literal drops a backslash that is not doubled, which can
		// leave the script unparsable with nothing else noticing.
		expect(() => new Function(body)).not.toThrow();
	});

	it("cannot end the <script> it is inlined in", () => {
		expect(body).not.toMatch(/<\//);
		expect(body).not.toMatch(/<!--/);
	});
});

describe("readCanvasPageMessage", () => {
	it("reads what the bridge posts", () => {
		expect(
			readCanvasPageMessage({
				type: "pockode:canvas-send",
				id: "pk1",
				action: "save",
				data: null,
			}),
		).toEqual({
			type: "pockode:canvas-send",
			id: "pk1",
			action: "save",
			data: null,
		});
		expect(
			readCanvasPageMessage({
				type: "pockode:canvas-patched",
				revision: 3,
				ok: false,
			}),
		).toEqual({ type: "pockode:canvas-patched", revision: 3, ok: false });
		expect(
			readCanvasPageMessage({ type: "pockode:canvas-focus", editable: true }),
		).toEqual({ type: "pockode:canvas-focus", editable: true });
		expect(readCanvasPageMessage({ type: "pockode:canvas-ready" })).toEqual({
			type: "pockode:canvas-ready",
		});
	});

	it("drops anything malformed, a page's script being free to post it", () => {
		for (const data of [
			null,
			"pockode:canvas-send",
			{ type: "pockode:canvas-send", id: "pk1", action: "", data: {} },
			{ type: "pockode:canvas-send", id: "pk1", action: "save" },
			{ type: "pockode:canvas-send", id: 1, action: "save", data: {} },
			{ type: "pockode:canvas-patched", revision: "3", ok: true },
			{ type: "pockode:canvas-focus", editable: "yes" },
			{ type: "pockode:canvas-patch", from_revision: 1, revision: 2, ops: [] },
		]) {
			expect(readCanvasPageMessage(data)).toBeNull();
		}
	});
});
