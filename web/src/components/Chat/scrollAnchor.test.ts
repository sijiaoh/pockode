import { beforeEach, describe, expect, it } from "vitest";
import { stubScrollBox } from "../../test/scrollBox";
import {
	anchorBlocksProps,
	anchorCandidateProps,
	anchorScrollTop,
	holdingAnchor,
	pickAnchor,
	type ScrollAnchor,
} from "./scrollAnchor";
import { foldPlaceProps } from "./useFoldLanding";

/** Where each element sits in the transcript; jsdom lays nothing out. */
const tops = new Map<Element, number>();
let container: HTMLElement;

function el(
	attrs: Record<string, string>,
	children: HTMLElement[] = [],
	top?: number,
): HTMLElement {
	const node = document.createElement("div");
	for (const [name, value] of Object.entries(attrs)) {
		node.setAttribute(name, value);
	}
	node.append(...children);
	if (top !== undefined) tops.set(node, top);
	return node;
}

const candidate = (top: number, children: HTMLElement[] = []) =>
	el(anchorCandidateProps, children, top);
const block = (top: number) => el({}, [], top);

beforeEach(() => {
	tops.clear();
	document.body.innerHTML = "";
	Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value(this: HTMLElement) {
			const top = this.closest("[hidden]") ? undefined : tops.get(this);
			return DOMRect.fromRect({
				y: top === undefined ? 0 : top - container.scrollTop,
			});
		},
	});
	Object.defineProperty(HTMLElement.prototype, "getClientRects", {
		configurable: true,
		value(this: HTMLElement) {
			return this.closest("[hidden]") ? [] : [this.getBoundingClientRect()];
		},
	});
});

/**
 * A transcript of two rows, everything here happening in the second: a part of
 * three Markdown blocks, then a tool list whose one row folds into its group's
 * summary.
 */
function transcript() {
	const blocks = [block(1000), block(1100), block(1200)];
	const part = candidate(1000, [el(anchorBlocksProps, blocks)]);
	const summary = el({ ...anchorCandidateProps, ...foldPlaceProps }, [], 1300);
	const slot = candidate(1340, [candidate(1340)]);
	const row = candidate(1000, [part, el({}, [summary, slot])]);
	container = el({}, [candidate(0, [candidate(0)]), row]);
	document.body.append(container);
	stubScrollBox(container, { contentHeight: 3000, viewportHeight: 500 });
	return { row, part, blocks, summary, slot };
}

function anchorAt(scrollTop: number): ScrollAnchor {
	container.scrollTop = scrollTop;
	const anchor = pickAnchor(container);
	if (!anchor) throw new Error("no anchor");
	return anchor;
}

const anchored = (anchor: ScrollAnchor | null) =>
	anchor?.path[anchor.path.length - 1];

describe("pickAnchor", () => {
	// One part can be screens of prose: a diagram settling in a block above the
	// reader moves the blocks below it, and not the part they are all in.
	it("anchors on the finest candidate at the top edge", () => {
		const { row, part, blocks } = transcript();

		const anchor = anchorAt(1150);

		expect(anchor.path.map((hold) => hold.el)).toEqual([row, part, blocks[1]]);
		tops.set(blocks[1], 1400);
		expect(anchorScrollTop(container, anchor)).toBe(1450);
	});
});

describe("holdingAnchor", () => {
	it("keeps the anchor while its element is laid out", () => {
		transcript();
		const anchor = anchorAt(1150);

		expect(holdingAnchor(container, anchor)).toBe(anchor);
	});

	it("falls back to the next level up when the anchored element is removed", () => {
		const { part, blocks } = transcript();
		const anchor = anchorAt(1150);

		blocks[1].remove();

		expect(anchored(holdingAnchor(container, anchor))).toEqual({
			el: part,
			offset: -150,
		});
	});

	it("falls back to the next level up when the anchored element is hidden", () => {
		const { part, blocks } = transcript();
		const anchor = anchorAt(1150);

		blocks[1].hidden = true;

		expect(anchored(holdingAnchor(container, anchor))?.el).toBe(part);
	});

	it("lands on the group's summary when the anchored row folds into it", () => {
		const { summary, slot } = transcript();
		const anchor = anchorAt(1360);
		expect(anchor.path[1].el).toBe(slot);

		slot.hidden = true;

		// Where the folded row's top was, but no higher than the view's top.
		expect(anchored(holdingAnchor(container, anchor))).toEqual({
			el: summary,
			offset: 0,
		});
	});

	// The commit that lost the anchor has already moved everything under the
	// view's old offset; what is at the edge now is not what the reader saw.
	it("takes no fresh anchor once nothing of the path is left", () => {
		const { row } = transcript();
		const anchor = anchorAt(1150);

		row.remove();

		expect(holdingAnchor(container, anchor)).toBeNull();
	});
});
