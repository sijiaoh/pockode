import { describe, expect, it } from "vitest";
import { openerOrSuccessor } from "./subagentTranscriptContext";

function chat(html: string): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = html;
	document.body.replaceChildren(root);
	return root;
}

/** An opener for run `a` that has left the DOM, as an unmounted entry has. */
function goneOpener(): HTMLElement {
	const opener = document.createElement("button");
	opener.setAttribute("data-subagent-opener", "a");
	return opener;
}

const row = (body: string) =>
	`<div data-tool-use-id="a"><button id="row">Explore</button>${body}</div>`;

describe("openerOrSuccessor", () => {
	it("is the opener while it is still there", () => {
		const root = chat(row(""));
		const opener = root.querySelector<HTMLElement>("#row");
		expect(opener && openerOrSuccessor(opener, root)).toBe(opener);
	});

	it("is the ⤢ now standing for the same run when the opener has gone", () => {
		const root = chat(
			row('<div><button id="open" data-subagent-opener="a">⤢</button></div>'),
		);
		expect(openerOrSuccessor(goneOpener(), root)?.id).toBe("open");
	});

	// An agents-list entry opens a transcript without its row ever opening.
	it("is the run's row when its ⤢ is in a closed body or not drawn", () => {
		const closed = chat(
			row(
				'<div hidden><button id="open" data-subagent-opener="a">⤢</button></div>',
			),
		);
		expect(openerOrSuccessor(goneOpener(), closed)?.id).toBe("row");
		const never = chat(row(""));
		expect(openerOrSuccessor(goneOpener(), never)?.id).toBe("row");
	});

	it("is nothing for an opener that named no run", () => {
		const root = chat(row(""));
		expect(
			openerOrSuccessor(document.createElement("button"), root),
		).toBeUndefined();
	});
});
