import { useCallback } from "react";
import { type RawSource, useRawMediaSource } from "../hooks/useRawMediaSource";
import { projectRelativeHtml } from "./htmlRender";
import {
	escapeAttribute,
	LEFT_LISTENER,
	pagePolicyMeta,
	pageReporterScript,
	WRAPPER_STYLE,
} from "./pageHosts";
import type { RawTarget } from "./rpc/raw";
import { useWSStore } from "./wsStore";

/**
 * What every frame an agent's page is drawn in shares — an `html_render` card
 * (`HtmlFrame`) and the canvas (`CanvasFrame`): the sandbox's floor, the
 * double frame, the order of the page document, and the project capability it
 * is drawn under (docs/tool-call-ui.md § A page the agent drew).
 */

/**
 * The floor under an agent's page, which the policy on its hosts is added to
 * and never traded for. Scripts run and popups open, and nothing more:
 *
 * - never `allow-same-origin`: the frame would share Pockode's origin, read its
 *   credentials and drive the agent — run commands on the user's machine;
 * - never `allow-modals`: reopening a session would throw up the `alert`s and
 *   `confirm`s of every old page in it.
 */
export const HTML_FRAME_SANDBOX =
	"allow-scripts allow-popups allow-popups-to-escape-sandbox";

/**
 * The canvas's sandbox: the floor and forms, since a canvas page is one the
 * reader works in and its forms are how it sends (`data-pk-send`) — without
 * `allow-forms` Chromium abandons a submission before its `submit` event, so
 * neither the bridge nor the page's own handler ever hears it (WebKit fires
 * the event regardless). Only the canvas: an `html_render` card has nothing
 * to submit to.
 *
 * A form let through here reaches no host by the policy's `form-action
 * 'none'` (`pagePolicy`), the wrapper's `frame-src` holding it too where it
 * navigates the frame. The one URL Chromium's `form-action` lets through is
 * the page's own `about:srcdoc`, a reload into itself, which the bridge holds
 * by cancelling a submit nobody handled (`canvasBridgeScript`).
 */
export const CANVAS_FRAME_SANDBOX = `${HTML_FRAME_SANDBOX} allow-forms`;

/**
 * The window the page's scripts post to: the app's, two frames up, past the
 * wrapper the page is drawn in.
 */
export const APP_FROM_PAGE = "parent.parent";

/**
 * What a page reaches of the project: a root capability for the worktree the
 * connection is on — the one HTML file previews load through — under no hosts,
 * since the page's own policy, written here, is what holds it to the reader's.
 */
const PROJECT_TARGET: RawTarget = {
	origin: { kind: "file" },
	scope: "root",
	page: { hosts: [] },
};

/**
 * The project a page is drawn under: `root` the capability's absolute URL,
 * ending in `/`, `workDir` the directory absolute paths in the page are made
 * relative to, and `expiresAt` when the capability stops serving it.
 */
export interface PageProject {
	root: string;
	workDir: string;
	expiresAt: number;
}

/**
 * The project a new document starts with: undefined while a capability is to
 * be asked for, which the frame waits for; null offline, where there is none
 * to wait for, and a page that reaches no project file is as readable without
 * one.
 */
export function initialPageProject(): PageProject | null | undefined {
	return useWSStore.getState().status === "connected" ? undefined : null;
}

/**
 * Asks for the project a document is drawn under: a capability with time left
 * on it (`fresh`), so a document drawn after hours is not drawn under one
 * that has expired.
 */
export function usePageProject(): (
	signal: AbortSignal,
) => Promise<PageProject> {
	const { fresh } = useRawMediaSource(PROJECT_TARGET, false);
	return useCallback(async (signal) => projectOf(await fresh(signal)), [fresh]);
}

function projectOf({ src, expiresAt }: RawSource): PageProject {
	return {
		root: new URL(src, location.href).href,
		workDir: useWSStore.getState().workDir,
		expiresAt,
	};
}

/** `html` with its absolute project paths made relative to the project. */
export function pageHtml(html: string, project: PageProject | null): string {
	return project ? projectRelativeHtml(html, project.workDir) : html;
}

const OWN_BASE = /<base\b[^>]*\bhref\s*=/i;

/**
 * The page as the frame draws it: the policy at byte 0, before anything the
 * agent wrote — a `srcdoc` document is never in quirks mode, so a doctype
 * after it changes nothing — then the base its relative URLs resolve
 * against, the root of the worktree, unless it sets its own, then the
 * reporter, so it hears what the head is refused, then what the frame puts
 * before the page (`before`), the page as written, and what it puts after.
 */
export function agentPageDocument(
	html: string,
	hosts: readonly string[],
	project: PageProject | null,
	{ before = "", after = "" }: { before?: string; after?: string } = {},
): string {
	// A page's own base is the one it was written against; ours would only
	// take its place, the first `<base href>` being the one that counts.
	const base =
		project && !OWN_BASE.test(html)
			? `<base href="${escapeAttribute(project.root)}">`
			: "";
	return `${pagePolicyMeta(hosts, project?.root)}${base}${pageReporterScript(APP_FROM_PAGE)}${before}${pageHtml(html, project)}${after}`;
}

/**
 * The document the page's frame sits in, which exists for its `frame-src`:
 * the browser checks the embedding document's policy on every navigation of a
 * frame, the ones the frame starts included, so the page cannot leave for a
 * host by navigating itself — by script, form, link or refresh. The app's own
 * document cannot be the embedder, being every page's at once.
 *
 * The page inherits this policy, as a `srcdoc` document does its parent's, so
 * it is the page's own: the two only ever differ by nothing. `style` is the
 * wrapper's own, a white sheet unless the frame says otherwise. `sandbox` is
 * the page frame's, and the wrapper's own frame has to carry the same: a
 * nested frame gets no flag its parent lacks.
 */
export function agentWrapperDocument(
	page: string,
	title: string,
	hosts: readonly string[],
	project: PageProject | null,
	{
		style = WRAPPER_STYLE,
		sandbox = HTML_FRAME_SANDBOX,
	}: { style?: string; sandbox?: string } = {},
): string {
	return `${pagePolicyMeta(hosts, project?.root)}<script>${LEFT_LISTENER}</script>${style}<iframe title="${escapeAttribute(title)}" sandbox="${sandbox}" srcdoc="${escapeAttribute(page)}"></iframe>`;
}

/**
 * The page's own window inside `wrapper`, or null while the wrapper has not
 * parsed its frame yet. `length` first: a cross-origin window throws on an
 * index it has no frame at.
 */
export function pageWindowOf(wrapper: HTMLIFrameElement | null): Window | null {
	const outer = wrapper?.contentWindow;
	if (!outer || outer.length === 0) return null;
	return outer[0];
}
