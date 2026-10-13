// Every attribute a browser loads or links a URL from, on whatever element
// carries it: `poster` on a video, `xlink:href` on SVG's `<use>` and `<image>`.
// `data` names a URL only on `<object>`.
const URL_ATTRIBUTES = ["src", "href", "xlink:href", "poster"];

// `scheme:` covers `data:`, `blob:`, `mailto:` and `javascript:` along with
// every absolute URL; `//host`, `/path` and their backslash spellings, which
// a browser reads the same way, leave the page's directory too.
const LEAVES_DIRECTORY = /^(?:[a-z][a-z\d+.-]*:|[/\\])/i;

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
// `image-set()` takes its URLs as bare strings as well as `url()`s.
const CSS_IMAGE_SET = /image-set\(([^)]*)\)/gi;
const CSS_STRING = /"([^"]*)"|'([^']*)'/g;

/** As a browser parses it: trimmed, with tabs and newlines dropped. */
function clean(value: string): string {
	return value.trim().replace(/[\t\n\r]/g, "");
}

function isRelative(value: string): boolean {
	const url = clean(value);
	return url !== "" && !url.startsWith("#") && !LEAVES_DIRECTORY.test(url);
}

/**
 * Each candidate's URL, without its descriptor. A URL is a run of
 * non-whitespace, so the comma inside a `data:` URL does not split it.
 */
function srcsetUrls(srcset: string): string[] {
	const urls: string[] = [];
	let rest = srcset;
	for (;;) {
		rest = rest.replace(/^[\s,]+/, "");
		const url = rest.match(/^\S+/)?.[0];
		if (!url) return urls;
		rest = rest.slice(url.length);
		if (url.endsWith(",")) {
			urls.push(url.replace(/,+$/, ""));
			continue;
		}
		urls.push(url);
		const comma = rest.indexOf(",");
		if (comma === -1) return urls;
		rest = rest.slice(comma + 1);
	}
}

function cssUrls(css: string): string[] {
	const imageSetStrings = [...css.matchAll(CSS_IMAGE_SET)].flatMap((set) => [
		...set[1].matchAll(CSS_STRING),
	]);
	return [
		...css.matchAll(CSS_URL),
		...css.matchAll(CSS_IMPORT),
		...imageSetStrings,
	].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function collectUrls(root: ParentNode, urls: string[]) {
	for (const element of root.querySelectorAll("*")) {
		// `<noscript>` is never shown in a frame that runs scripts; `<base>` is
		// read on its own.
		if (element.closest("noscript, base")) continue;
		for (const name of URL_ATTRIBUTES) {
			const value = element.getAttribute(name);
			if (value != null) urls.push(value);
		}
		const srcset = element.getAttribute("srcset");
		if (srcset != null) urls.push(...srcsetUrls(srcset));
		const style = element.getAttribute("style");
		if (style != null) urls.push(...cssUrls(style));
		// By name rather than class: a `<style>` inside an inline `<svg>` is an
		// SVG element, and loads its `url()`s all the same.
		if (element.localName === "object") {
			urls.push(element.getAttribute("data") ?? "");
		} else if (element.localName === "style") {
			urls.push(...cssUrls(element.textContent ?? ""));
		} else if (element instanceof HTMLTemplateElement) {
			// A template's elements are in a fragment of their own, out of reach
			// of a query on the document.
			collectUrls(element.content, urls);
		}
	}
}

/**
 * Whether an HTML page refers to a file beside or beneath it by a relative
 * URL — what a page loaded through a capability for itself alone cannot
 * reach (docs/file.md, "HTML pages"). A URL from the root (`/x`) is not
 * counted: it misses the page's directory under any capability. A URL only a
 * script builds — `fetch("data.json")`, an inline `import` — is out of reach
 * of a scan that runs nothing.
 *
 * `DOMParser` builds the document without running a script or fetching
 * anything.
 */
export function hasRelativeReferences(html: string): boolean {
	const doc = new DOMParser().parseFromString(html, "text/html");

	// Only the first `<base>` counts, as in a browser; one that leaves the
	// page's directory sends every relative URL with it.
	const base = doc.querySelector("base[href]")?.getAttribute("href");
	if (base != null && LEAVES_DIRECTORY.test(clean(base))) return false;

	const urls: string[] = [];
	collectUrls(doc, urls);
	return urls.some(isRelative);
}
