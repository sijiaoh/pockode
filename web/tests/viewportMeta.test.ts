import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGES } from "./sourceScan";

// A soft keyboard, by default, shrinks only the visual viewport and leaves the
// layout viewport where it was — so every `dvh` height, every `fixed` box and
// every `max-height` media query keeps measuring the screen as if the keyboard
// were not there. `interactive-widget=resizes-content` asks the browser to
// shrink the layout viewport instead, and two things lean on it:
//
// - `Sheet` (packages/shared) is a `fixed inset-0` overlay whose content is
//   sized in `dvh`. Unless the layout viewport shrinks, the bottom of the
//   sheet — the field being typed in and the buttons under it — sits behind
//   the keyboard. Both frontends render `Sheet`, so both pages have to ask.
// - web's short-viewport gate (`useShortViewport`) is a `max-height` query and
//   only flips when the layout viewport moves.
//
// Nothing else notices the setting going missing: the page still renders, and
// the keyboard just covers it on the phones it matters on, with every other
// test green. The setting lives in each project's own `index.html` rather than
// anywhere shared, which is why it is checked per page.
//
// iOS Safari ignores the setting; see docs/answering-ui.md
// § Room on a short viewport.

describe("the viewport meta tag", () => {
	it.each(
		Object.entries(PAGES),
	)("asks %s to resize its content for the soft keyboard", (_name, path) => {
		const html = readFileSync(resolve(process.cwd(), path), "utf8");
		expect(html).toMatch(
			/name="viewport"[^>]*interactive-widget=resizes-content/,
		);
	});
});
