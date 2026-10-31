import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasOp, CanvasState } from "../types/canvas";
import {
	type CanvasPatch,
	CanvasRedraw,
	PATCH_TIMEOUT_MS,
	type RedrawTarget,
} from "./canvasRedraw";

const OPS: CanvasOp[] = [{ op: "remove", region: "spinner" }];

function render(revision: number): CanvasState {
	return { revision, html: `<p>${revision}</p>`, change: { kind: "render" } };
}

function update(revision: number, from = revision - 1): CanvasState {
	return {
		revision,
		html: `<p>${revision}</p>`,
		change: { kind: "update", from_revision: from, ops: OPS },
	};
}

/** A frame that records what it was told and takes every patch. */
function frame(overrides: Partial<RedrawTarget> = {}) {
	const drawn: number[] = [];
	const patches: CanvasPatch[] = [];
	const patchedInto: number[] = [];
	const target: RedrawTarget = {
		draw: (state) => drawn.push(state.revision),
		patched: (state) => patchedInto.push(state.revision),
		patch: (patch) => {
			patches.push(patch);
			return true;
		},
		patchable: () => true,
		...overrides,
	};
	return { target, drawn, patches, patchedInto };
}

/** A redraw showing revision `at`, drawn whole and loaded. */
function showing(at: number, overrides?: Partial<RedrawTarget>) {
	const f = frame(overrides);
	const redraw = new CanvasRedraw(f.target);
	redraw.show(render(at));
	redraw.loaded();
	f.drawn.length = 0;
	return { ...f, redraw };
}

describe("CanvasRedraw", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("draws nothing for revision 0", () => {
		const { target, drawn } = frame();
		const redraw = new CanvasRedraw(target);
		redraw.show({ revision: 0 });
		expect(drawn).toEqual([]);
		expect(redraw.shown).toBe(0);
	});

	it("patches an update from the revision the frame shows", () => {
		const { redraw, drawn, patches, patchedInto } = showing(3);
		redraw.show(update(4));
		expect(patches).toEqual([{ from_revision: 3, revision: 4, ops: OPS }]);
		expect(drawn).toEqual([]);

		// A send in between still comes from the page as it is.
		expect(redraw.shown).toBe(3);
		redraw.patched(4, true);
		expect(redraw.shown).toBe(4);
		expect(patchedInto).toEqual([4]);
	});

	it("draws whole a render, or an update from another revision", () => {
		const { redraw, drawn, patches } = showing(3);
		redraw.show(render(4));
		expect(drawn).toEqual([4]);
		redraw.loaded();

		redraw.show(update(6, 5));
		expect(drawn).toEqual([4, 6]);
		expect(patches).toEqual([]);
		expect(redraw.shown).toBe(6);
	});

	it("draws whole when the capability is about to expire", () => {
		const { redraw, drawn, patches } = showing(3, { patchable: () => false });
		redraw.show(update(4));
		expect(patches).toEqual([]);
		expect(drawn).toEqual([4]);
	});

	it("draws whole when there is no page to post the patch to", () => {
		const { redraw, drawn } = showing(3, { patch: () => false });
		redraw.show(update(4));
		expect(drawn).toEqual([4]);
	});

	it("draws whole a patch the page could not apply", () => {
		const { redraw, drawn } = showing(3);
		redraw.show(update(4));
		redraw.patched(4, false);
		expect(drawn).toEqual([4]);
		expect(redraw.shown).toBe(4);
	});

	it("draws whole a patch unanswered for two seconds, and ignores a late answer", () => {
		const { redraw, drawn, patchedInto } = showing(3);
		redraw.show(update(4));
		vi.advanceTimersByTime(PATCH_TIMEOUT_MS - 1);
		expect(drawn).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(drawn).toEqual([4]);

		redraw.patched(4, true);
		expect(patchedInto).toEqual([]);
	});

	it("keeps one patch out at a time, and patches on from the answer", () => {
		const { redraw, patches, drawn } = showing(3);
		redraw.show(update(4));
		redraw.show(update(5));
		expect(patches.map((p) => p.revision)).toEqual([4]);

		redraw.patched(4, true);
		expect(patches.map((p) => p.revision)).toEqual([4, 5]);
		redraw.patched(5, true);
		expect(redraw.shown).toBe(5);
		expect(drawn).toEqual([]);
	});

	it("compares the newest state once the answer comes, skipping those in between", () => {
		const { redraw, patches, drawn } = showing(3);
		redraw.show(update(4));
		redraw.show(update(5));
		redraw.show(update(6));
		// 6 comes from 5, which the frame never showed.
		redraw.patched(4, true);
		expect(patches.map((p) => p.revision)).toEqual([4]);
		expect(drawn).toEqual([6]);
	});

	it("takes only the answer for the patch it posted, and only the first", () => {
		const { redraw, patchedInto } = showing(3);
		redraw.show(update(4));
		redraw.patched(5, true);
		expect(redraw.shown).toBe(3);

		redraw.patched(4, true);
		redraw.patched(4, false);
		expect(redraw.shown).toBe(4);
		expect(patchedInto).toEqual([4]);
	});

	it("does not patch a page that has not loaded yet: the newer state waits for the load", () => {
		const f = frame();
		const redraw = new CanvasRedraw(f.target);
		redraw.show(render(3));
		redraw.show(update(4));
		expect(f.patches).toEqual([]);

		redraw.loaded();
		expect(f.patches.map((p) => p.revision)).toEqual([4]);
		expect(f.drawn).toEqual([3]);
	});

	it("draws the newer state whole when the page does not load within two seconds", () => {
		const f = frame();
		const redraw = new CanvasRedraw(f.target);
		redraw.show(render(3));
		redraw.show(update(4));
		vi.advanceTimersByTime(PATCH_TIMEOUT_MS);
		expect(f.drawn).toEqual([3, 4]);
		expect(f.patches).toEqual([]);
	});

	it("redraws the newest state whole on request, dropping the patch out", () => {
		const { redraw, drawn, patchedInto } = showing(3);
		redraw.show(update(4));
		redraw.redraw();
		expect(drawn).toEqual([4]);
		redraw.patched(4, true);
		expect(patchedInto).toEqual([]);
	});
});
