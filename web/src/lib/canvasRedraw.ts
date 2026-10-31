import type { CanvasOp, CanvasState } from "../types/canvas";

/**
 * How long a patch has to be answered, and a page drawn whole has to load
 * before a newer state waits no longer: then the newest is drawn whole
 * (docs/canvas-ui.md §8.3).
 */
export const PATCH_TIMEOUT_MS = 2000;

export interface CanvasPatch {
	from_revision: number;
	revision: number;
	ops: CanvasOp[];
}

/** What the redraw drives: the frame the canvas is drawn in. */
export interface RedrawTarget {
	/**
	 * Draws `state` whole, as a new document. Its load is reported back with
	 * `loaded`.
	 */
	draw: (state: CanvasState) => void;
	/** The page now shows `state`, patched into it. */
	patched: (state: CanvasState) => void;
	/**
	 * Posts `patch` to the page now in the frame; false when there is none to
	 * post to.
	 */
	patch: (patch: CanvasPatch) => boolean;
	/**
	 * Whether the document in the frame may be patched for longer: its project
	 * capability has the `fresh` margin left (§4).
	 */
	patchable: () => boolean;
}

type Busy = { kind: "loading" } | { kind: "patch"; state: CanvasState } | null;

/**
 * Decides how each new canvas state reaches the frame (§8.3): a patch in place
 * when the frame shows the update's `from_revision`, else a whole drawing; one
 * patch at a time; and the newest state compared again once the frame is free.
 *
 * `shown` is the app's own record of the revision in the frame — what a send
 * from it carries — never the page's: it moves to a patch's revision only on
 * that patch's first answer, and to a whole drawing's when it is drawn. While a
 * patch is out it stays at `from_revision`.
 *
 * A document drawn whole is busy until it has loaded, since the bridge hears
 * nothing before it runs: a state arriving meanwhile waits for the load, for
 * as long as an answer would be waited for.
 */
export class CanvasRedraw {
	private shownRevision = 0;
	private latest: CanvasState | null = null;
	private busy: Busy = null;
	private timer: ReturnType<typeof setTimeout> | null = null;

	private readonly target: RedrawTarget;

	constructor(target: RedrawTarget) {
		this.target = target;
	}

	/** The revision the frame shows; 0 before anything was drawn. */
	get shown(): number {
		return this.shownRevision;
	}

	/** A new state — the newest the app has. */
	show(state: CanvasState) {
		this.latest = state;
		if (this.busy === null) {
			this.settle();
		} else if (this.timer === null && state.revision !== this.shownRevision) {
			this.startTimer();
		}
	}

	/** The document drawn last has loaded. */
	loaded() {
		if (this.busy?.kind !== "loading") return;
		this.free();
		this.settle();
	}

	/** The page's answer to a patch; only the first for the patch out counts. */
	patched(revision: number, ok: boolean) {
		const busy = this.busy;
		if (busy?.kind !== "patch" || busy.state.revision !== revision) return;
		this.free();
		if (ok) {
			this.shownRevision = revision;
			this.target.patched(busy.state);
			this.settle();
		} else {
			this.drawLatest();
		}
	}

	/** Draws the newest state whole again, whatever the frame shows. */
	redraw() {
		this.free();
		this.drawLatest();
	}

	dispose() {
		this.free();
	}

	private settle() {
		const state = this.latest;
		if (state === null || state.revision === this.shownRevision) return;
		const change = state.change;
		if (
			change?.kind === "update" &&
			change.from_revision === this.shownRevision &&
			this.target.patchable() &&
			this.target.patch({
				from_revision: change.from_revision,
				revision: state.revision,
				ops: change.ops,
			})
		) {
			this.busy = { kind: "patch", state };
			this.startTimer();
			return;
		}
		this.drawLatest();
	}

	private drawLatest() {
		const state = this.latest;
		if (state === null) return;
		this.shownRevision = state.revision;
		this.busy = state.revision === 0 ? null : { kind: "loading" };
		this.target.draw(state);
	}

	private startTimer() {
		this.timer = setTimeout(() => {
			this.timer = null;
			this.busy = null;
			if (this.latest?.revision !== this.shownRevision) this.drawLatest();
		}, PATCH_TIMEOUT_MS);
	}

	private free() {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		this.busy = null;
	}
}
