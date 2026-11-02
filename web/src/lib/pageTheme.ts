/**
 * The theme an agent's page may ask for (docs/tool-call-ui.md § Theme: a page
 * that asks for it): the `--pk-*` variables, the base stylesheet that carries
 * them, and the messages that keep a drawn page in the theme shown. Ported
 * from the canvas branch's `canvasBridge.ts`, so a page and a canvas are one
 * contract to the agent. The bridge (`pageBridge.ts`) applies it in the page;
 * `HtmlFrame` is the app side.
 */

import { MEDIA_QUERIES } from "@pockode/shared";
import { useThemeStore } from "./themeStore";

/**
 * Each `--pk-*` variable a page may use and the app token it takes its value
 * from. The names are a promise to every page ever drawn: add one only
 * deliberately, and never rename or remove one. `html_render`'s and
 * `html_edit`'s descriptions (`server/mcp/tools.go`) list the same names, and
 * `web/tests/pageThemeTokens.test.ts` holds the two equal.
 */
export const PAGE_THEME_TOKENS = {
	"--pk-bg": "--th-bg-primary",
	"--pk-bg-secondary": "--th-bg-secondary",
	"--pk-bg-tertiary": "--th-bg-tertiary",
	"--pk-text": "--th-text-primary",
	"--pk-text-secondary": "--th-text-secondary",
	"--pk-text-muted": "--th-text-muted",
	"--pk-border": "--th-border",
	"--pk-accent": "--th-accent",
	"--pk-accent-text": "--th-accent-text",
	"--pk-accent-hover": "--th-accent-hover",
	"--pk-success": "--th-success",
	"--pk-error": "--th-error",
	"--pk-warning": "--th-warning",
	"--pk-code-bg": "--th-code-bg",
	"--pk-code-text": "--th-code-text",
} as const;

export type PageThemeVar = keyof typeof PAGE_THEME_TOKENS;

export type PageScheme = "light" | "dark";

export interface PageTheme {
	scheme: PageScheme;
	vars: Partial<Record<PageThemeVar, string>>;
}

export const PAGE_THEME_VARS = Object.keys(PAGE_THEME_TOKENS) as PageThemeVar[];

/**
 * What can continue a CSS name: an ASCII letter, digit, `-` or `_`, or any
 * non-ASCII character.
 */
const NAME_CHAR = "[\\w\\-\\u0080-\\uffff]";

/**
 * One of the theme's own names, not a longer one of the page's around it
 * (`--x--pk-bg`, `--pk-bgx`): nothing that can continue a name on either side.
 * A boundary on the left rather than a lookbehind, which older Safari lacks.
 */
const ASKS_FOR_THEME = new RegExp(
	`(?:^|(?!${NAME_CHAR}).)(?:${PAGE_THEME_VARS.map((name) => name.replace(/-/g, "\\-")).join("|")})(?!${NAME_CHAR})`,
	"s",
);

/**
 * Whether a page follows the theme: its HTML, as stored, names one of the
 * theme's variables — `var(--pk-bg)`, or `--pk-accent: …` overriding one. A
 * `--pk-` name of the page's own (`--pk-gap`) is not asking. Read from the
 * source, so it is decided before the frame is drawn and never changes for
 * that page.
 */
export function followsTheme(html: string): boolean {
	return ASKS_FOR_THEME.test(html);
}

/** The theme as `style` — the app's computed root style — holds it now. */
export function pageThemeFrom(
	style: CSSStyleDeclaration,
	scheme: PageScheme,
): PageTheme {
	const vars: PageTheme["vars"] = {};
	for (const name of PAGE_THEME_VARS) {
		const value = style.getPropertyValue(PAGE_THEME_TOKENS[name]).trim();
		if (value) vars[name] = value;
	}
	return { scheme, vars };
}

/** The theme the app shows now. */
export function currentPageTheme(): PageTheme {
	return pageThemeFrom(
		getComputedStyle(document.documentElement),
		useThemeStore.getState().resolvedMode,
	);
}

/**
 * The base stylesheet's attribute, by which the bridge finds it to rewrite,
 * and whose value is the scheme the stylesheet is in now.
 */
export const BASE_ATTRIBUTE = "data-pockode-page-base";

/**
 * What the root gets beside the variables: the theme applied, or a dark page
 * would start as black text on a dark ground, and the accent on the controls
 * the rules below leave native (checkboxes, radios, ranges).
 */
export const ROOT_CSS =
	"background:var(--pk-bg);color:var(--pk-text);accent-color:var(--pk-accent)";

/** The inputs that are a box holding text or a press, not a native widget. */
const BOXED_INPUT =
	"input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=hidden],[type=image])";
const BOXED = `button,${BOXED_INPUT},select,textarea`;
const CONTROL = "button,input,select,textarea";

/**
 * The elements a `data-pk-send` is on that the browser already lets the
 * keyboard reach and operate, or that send by a gesture of their own (a form's
 * submit, a field's Enter). Any other element with an action the bridge makes
 * a button of.
 */
export const NATIVE_SEND = "button,input,select,textarea,form,a[href],summary";

/**
 * A `div`, `li` or card that sends: the bridge gives it a button's role, tab
 * stop and keys. It looks like a plain button, never the accent — a card
 * painted in the primary's fill would not be the agent's card any more.
 */
const CUSTOM_PRESSABLE = `[data-pk-send]:not([data-pk-send=""],${NATIVE_SEND})`;

/**
 * What a press acts on, and so looks pressable: a pointer cursor, a hover
 * fill. Its rules leave out the disabled by `:not(:disabled)` rather than
 * `:enabled`, which matches no element without a disabled state — a
 * `CUSTOM_PRESSABLE` among them.
 */
const PRESSABLE = `button,input:is([type=button],[type=submit],[type=reset]),${CUSTOM_PRESSABLE}`;

/**
 * The pressables that send: the page's primary action, in the accent. A
 * `type="button"` or `reset` button in a sending form is no send, so it keeps
 * the plain fill.
 */
const PRIMARY =
	"button[data-pk-send],form[data-pk-send] :is(button:not([type=button],[type=reset]),input[type=submit])";

/** Pockode's own `transition-colors` (Tailwind's 150ms ease). */
const COLOR_TRANSITION =
	"transition-property:color,background-color,border-color;transition-timing-function:cubic-bezier(.4,0,.2,1);transition-duration:.15s";

/**
 * The cascade layer the whole base stylesheet is in. Zero specificity alone
 * would lose to every agent rule in a layer — Tailwind's browser build and
 * Pico put all of theirs in one — since unlayered rules beat layered ones; a
 * layer named first in the document is below every other, and below every
 * unlayered rule.
 */
export const LAYER = "pockode-base";

/**
 * The theme-independent half of the base stylesheet. Every selector is also
 * wholly inside `:where()`, pseudo-classes included, so each rule weighs
 * nothing. Order matters among them for that reason: the accent, the hover
 * fills and the dimming each come after what they override.
 *
 * The hover fills are Pockode's own buttons' — the tertiary background, and
 * the accent's hover shade on a primary — and only where the primary pointer
 * can hover, as the app's `pointer-fine:` gate: a tap would otherwise leave
 * the fill stuck on. A disabled control takes none.
 */
export const STATIC_CSS = [
	`:where(${CONTROL}){font:inherit}`,
	`:where(${BOXED}){box-sizing:border-box;color:inherit;background:var(--pk-bg-secondary);border:1px solid var(--pk-border);border-radius:6px;padding:.375em .75em}`,
	`:where(${PRIMARY}){background:var(--pk-accent);border-color:var(--pk-accent);color:var(--pk-accent-text)}`,
	`:where(${PRESSABLE}){cursor:pointer;${COLOR_TRANSITION}}`,
	`@media ${MEDIA_QUERIES.finePointer}{:where(:is(${PRESSABLE}):not(:disabled):hover){background-color:var(--pk-bg-tertiary)}:where(:is(${PRIMARY}):not(:disabled):hover){background-color:var(--pk-accent-hover);border-color:var(--pk-accent-hover)}}`,
	`@media (prefers-reduced-motion:reduce){:where(${PRESSABLE}){transition:none}}`,
	`:where(:is(${CONTROL},${CUSTOM_PRESSABLE}):focus-visible){outline:2px solid var(--pk-accent);outline-offset:1px}`,
	`:where(:is(${CONTROL}):disabled){opacity:.5;cursor:not-allowed}`,
	// The coarse-pointer hit-area floor (docs/responsive-ui.md).
	`@media ${MEDIA_QUERIES.anyCoarsePointer}{:where(${BOXED}){min-height:44px}}`,
].join("");

/**
 * The whole base stylesheet for `theme`. The bridge builds the same text when
 * the theme changes (`themeCss` in its script); a test holds the two equal.
 */
export function pageBaseCss(theme: PageTheme): string {
	let declarations = `color-scheme:${theme.scheme === "dark" ? "dark" : "light"}`;
	for (const name of PAGE_THEME_VARS) {
		const value = theme.vars[name];
		if (typeof value === "string") declarations += `;${name}:${value}`;
	}
	return `@layer ${LAYER}{:where(:root){${declarations};${ROOT_CSS}}${STATIC_CSS}}`;
}

/**
 * The base stylesheet as markup, for the page document after the bridge and
 * right before the agent's own. A `<` cannot end the element: it is written
 * as the CSS escape it means.
 */
export function pageBaseStylesheet(theme: PageTheme): string {
	return `<style ${BASE_ATTRIBUTE}="${theme.scheme === "dark" ? "dark" : "light"}">${pageBaseCss(theme).replace(/</g, "\\3c ")}</style>`;
}

export const PAGE_READY = "pockode:page-ready";
export const PAGE_THEMED = "pockode:page-themed";
export const PAGE_THEME = "pockode:page-theme";
export const PAGE_FRAME_SCHEME = "pockode:page-frame-scheme";

/**
 * What a themed page's bridge says: it is parsed (on every load of the
 * document), or it applied a theme the app posted — each with the scheme it
 * is in now. Untrusted: the page's own scripts can post it too, and all it
 * can do is show its frame early.
 */
export type PageThemeReport =
	| { type: typeof PAGE_READY; scheme: PageScheme | null }
	| { type: typeof PAGE_THEMED; scheme: PageScheme };

function readScheme(value: unknown): PageScheme | null {
	return value === "light" || value === "dark" ? value : null;
}

export function readPageThemeReport(data: unknown): PageThemeReport | null {
	if (typeof data !== "object" || data === null) return null;
	const message = data as Record<string, unknown>;
	if (message.type === PAGE_READY) {
		return { type: PAGE_READY, scheme: readScheme(message.scheme) };
	}
	const scheme = readScheme(message.scheme);
	return message.type === PAGE_THEMED && scheme
		? { type: PAGE_THEMED, scheme }
		: null;
}

/**
 * The wrapper of a page that follows the theme: transparent, so where the
 * page does not paint, the frame element's `bg-th-bg-primary` shows, and under
 * the scheme shown — the frame element's — so the two never disagree, which in
 * Chromium and WebKit paints an opaque canvas of the document's scheme in the
 * frame. Its listener takes the scheme alone, and from the app only.
 */
export function themedWrapperStyle(scheme: PageScheme): string {
	return `<style>:root{color-scheme:${scheme}}html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style><script>addEventListener("message",function(e){var d=e.data;if(e.source===parent&&d&&d.type==="${PAGE_FRAME_SCHEME}")document.documentElement.style.colorScheme=d.scheme==="dark"?"dark":"light";});</script>`;
}
