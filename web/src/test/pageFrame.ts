import { act } from "@testing-library/react";

/**
 * A workspace page's own frame, inside the wrapper the app holds
 * (`rawPageWrapper`): jsdom does not draw a `srcdoc`, so it is read from it.
 */
export function pageFrameOf(wrapper: HTMLIFrameElement) {
	const page = new DOMParser()
		.parseFromString(wrapper.srcdoc, "text/html")
		.querySelector("iframe");
	if (!page) throw new Error("the wrapper holds no page frame");
	return page;
}

/** The URL the wrapper was drawn to load its page from. */
export function pageUrlOf(wrapper: HTMLIFrameElement) {
	return pageFrameOf(wrapper).getAttribute("src");
}

/**
 * The wrapper saying its page has loaded: the frame's load, as the app hears
 * it.
 */
export function pageLoaded(wrapper: HTMLIFrameElement) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "pockode:page-loaded" },
				source: wrapper.contentWindow,
			}),
		);
	});
}
