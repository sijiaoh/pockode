import {
	type CSSProperties,
	type Ref,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePageReports } from "../../hooks/usePageReports";
import { useRawMediaSource } from "../../hooks/useRawMediaSource";
import { projectRelativeHtml } from "../../lib/htmlRender";
import {
	type PageSendMessage,
	pageBridgeScript,
	readPageSend,
	SEND_REFUSAL_MESSAGES,
	type SendRefusal,
	sendAccepted,
	sendRefused,
	sendsToAgent,
} from "../../lib/pageBridge";
import {
	allowedPageHosts,
	allowPageHosts,
	escapeAttribute,
	LEFT_LISTENER,
	pagePolicyMeta,
	pageReporterScript,
	useAllowedPageHosts,
	WRAPPER_STYLE,
} from "../../lib/pageHosts";
import { startPageSend } from "../../lib/pageSends";
import {
	currentPageTheme,
	followsTheme,
	PAGE_FRAME_SCHEME,
	PAGE_READY,
	PAGE_THEME,
	type PageTheme,
	pageBaseStylesheet,
	readPageThemeReport,
	themedWrapperStyle,
} from "../../lib/pageTheme";
import { subscribeThemeRegistry } from "../../lib/registries/themeRegistry";
import type { RawTarget } from "../../lib/rpc/raw";
import { useSessionView } from "../../lib/sessionView";
import { useThemeStore } from "../../lib/themeStore";
import {
	isAwaitingPermissionRejection,
	isInvalidParamsRejection,
	useWSStore,
} from "../../lib/wsStore";
import { asError } from "../../utils/errorMessage";
import PageNotice from "../Media/PageNotice";
import { FrameShield } from "../ui/FrameShield";
import { PageHostsStrip } from "../ui/PageHostsStrip";
import { PageSendLine } from "./PageSendLine";
import { usePageSender } from "./pageSendContext";

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
 * The floor and forms, for an agent's page that sends (`sendsToAgent`): its
 * forms are how it sends, and without `allow-forms` Chromium abandons a
 * submission before its `submit` event, so neither the bridge nor the page's
 * own handler ever hears it. Only with the bridge, whose cancel of a submit
 * nobody handled keeps a plain form from reloading the page into its own
 * `about:srcdoc`; every other destination is refused by the policy's
 * `form-action 'none'`, and by the wrapper's `frame-src` where the form
 * navigates the frame (docs/tool-call-ui.md § Forms in a page).
 */
export const AGENT_PAGE_SANDBOX = `${HTML_FRAME_SANDBOX} allow-forms`;

const HEIGHT_MESSAGE = "pockode:html-height";

/**
 * How long a new document of a page that follows the theme stays hidden when
 * it never says it is ready in the scheme shown — a page whose own script
 * broke the bridge is shown anyway, as it is.
 */
const THEMED_SHOW_TIMEOUT_MS = 2000;

/**
 * The window the page's scripts post to: the app's, two frames up, past the
 * wrapper the page is drawn in.
 */
const APP_FROM_PAGE = "parent.parent";

/**
 * Appended to the page so it can say how tall it is: a sandboxed frame has an
 * opaque origin, so its document cannot be measured from outside. The
 * document element rather than the body, because a srcdoc document is never in
 * quirks mode, so it is as tall as its content and not as the frame — unless
 * the page pins it to the frame (`html, body { height: 100% }`, common in
 * generated pages), when only its overflow, the scroll height, says how tall
 * the content is. Below the root's client height the scroll height is that
 * height, so it is read only past it, or a page could never shrink.
 *
 * A page wider than the frame scrolls sideways inside it, and where scrollbars
 * take room that scrollbar takes it off the client height: the frame is the
 * content plus the scrollbar — the viewport's height past the client height —
 * or the page would scroll down by the scrollbar's height as well.
 */
const HEIGHT_REPORTER = `<script>(function(){var last=-1;function report(){var d=document.documentElement;var h=Math.ceil((d.scrollHeight>d.clientHeight?d.scrollHeight:d.getBoundingClientRect().height)+innerHeight-d.clientHeight);if(h!==last){last=h;${APP_FROM_PAGE}.postMessage({type:"${HEIGHT_MESSAGE}",height:h},"*");}}new ResizeObserver(report).observe(document.documentElement);addEventListener("load",report);})();</script>`;

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
 * ending in `/`, and `workDir` the directory absolute paths in the page are
 * made relative to.
 */
interface Project {
	root: string;
	workDir: string;
}

const OWN_BASE = /<base\b[^>]*\bhref\s*=/i;

/**
 * The page as the frame draws it: the policy at byte 0, before anything the
 * agent wrote — a `srcdoc` document is never in quirks mode, so a doctype
 * after it changes nothing — then the base its relative URLs resolve
 * against, the root of the worktree, unless it sets its own, then the
 * reporter, so it hears what the head is refused, then — in a page that
 * sends or follows the theme — the bridge, so markup the parser inserts is
 * seen by it, then — in a page that follows the theme — the base stylesheet,
 * below anything the agent wrote, then the page as written.
 */
function pageDocument(
	{ html, sized, sends, themed }: Source,
	theme: PageTheme,
	hosts: readonly string[],
	project: Project | null,
) {
	// A page's own base is the one it was written against; ours would only
	// take its place, the first `<base href>` being the one that counts.
	const base =
		project && !OWN_BASE.test(html)
			? `<base href="${escapeAttribute(project.root)}">`
			: "";
	const page = project ? projectRelativeHtml(html, project.workDir) : html;
	const bridge =
		sends || themed ? pageBridgeScript(APP_FROM_PAGE, { sends, themed }) : "";
	const baseStyle = themed ? pageBaseStylesheet(theme) : "";
	return `${pagePolicyMeta(hosts, project?.root)}${base}${pageReporterScript(APP_FROM_PAGE)}${bridge}${baseStyle}${page}${sized ? `\n${HEIGHT_REPORTER}` : ""}`;
}

/**
 * The document the page's frame sits in, which exists for its `frame-src`:
 * the browser checks the embedding document's policy on every navigation of a
 * frame, the ones the frame starts included, so the page cannot leave for a
 * host by navigating itself — by script, form, link or refresh. The app's own
 * document cannot be the embedder, being every page's at once.
 *
 * The page inherits this policy, as a `srcdoc` document does its parent's, so
 * it is the page's own: the two only ever differ by nothing. The page's
 * frame carries the sandbox the wrapper's does: a nested frame gets no flag
 * its parent lacks.
 *
 * A page that follows the theme is drawn in the theme current now; later ones
 * are posted to it, and the scheme to its wrapper, without drawing it again.
 */
function wrapperDocument(
	source: Source,
	theme: PageTheme,
	hosts: readonly string[],
	project: Project | null,
) {
	const style = source.themed
		? themedWrapperStyle(theme.scheme)
		: WRAPPER_STYLE;
	return `${pagePolicyMeta(hosts, project?.root)}<script>${LEFT_LISTENER}</script>${style}<iframe title="${escapeAttribute(source.title)}" sandbox="${sandboxOf(source)}" srcdoc="${escapeAttribute(pageDocument(source, theme, hosts, project))}"></iframe>`;
}

function sandboxOf(source: Source): string {
	return source.sends ? AGENT_PAGE_SANDBOX : HTML_FRAME_SANDBOX;
}

/** What a page is drawn from; another of any of these is another document. */
interface Source {
	html: string;
	title: string;
	pageKey: string;
	sized: boolean;
	/** Drawn with the bridge's send and forms (`sendsToAgent`). */
	sends: boolean;
	/** Drawn in the theme, and kept in it (`followsTheme`). */
	themed: boolean;
}

/** Which document is in the frame, and the hosts its policy allows. */
interface DrawnDocument {
	id: number;
	source: Source;
	hosts: readonly string[];
	/**
	 * The theme current when it was drawn — no part of its `Source`: a theme
	 * change posts the new one rather than drawing another document.
	 */
	theme: PageTheme;
	/** Drawn by a Load, which hands the frame the focus. */
	byLoad: boolean;
	/**
	 * Undefined while the capability is being asked for, and the frame waits
	 * for it; null when there is none to be had, and the page is drawn as it
	 * was before it could reach the project.
	 */
	project: Project | null | undefined;
	/** Why there is no project to be had, when asking for it failed. */
	projectError: Error | null;
}

function drawn(source: Source, id: number, byLoad: boolean): DrawnDocument {
	return {
		id,
		source,
		hosts: [...allowedPageHosts(source.pageKey)].sort(),
		theme: source.themed ? currentPageTheme() : { scheme: "light", vars: {} },
		byLoad,
		// Offline there is no capability to wait for, and a page that reaches
		// no project file is as readable without one.
		project: useWSStore.getState().status === "connected" ? undefined : null,
		projectError: null,
	};
}

function sameSource(a: Source, b: Source): boolean {
	return (
		a.html === b.html &&
		a.title === b.title &&
		a.pageKey === b.pageKey &&
		a.sized === b.sized &&
		a.sends === b.sends &&
		a.themed === b.themed
	);
}

interface Props {
	html: string;
	title: string;
	/**
	 * The page the reader's allowance is for: one `html_render` or `html_edit`
	 * call, whichever view it is drawn in.
	 */
	pageKey: string;
	/**
	 * The id the page is stored under (`p3`), which a send names. Without one
	 * — a card from before ids — the page never sends, whatever its HTML says.
	 */
	page?: string;
	/** The page's height whenever it changes; the frame is then sized by it. */
	onHeight?: (height: number) => void;
	/**
	 * False while the page is hidden under something, so the strip is not
	 * announced unseen — and is announced again when the page is shown.
	 */
	shown?: boolean;
	className?: string;
	/** The box the frame fills, under the strip. */
	boxRef?: Ref<HTMLDivElement>;
	boxClassName?: string;
	boxStyle?: CSSProperties;
}

/**
 * An agent's HTML page, as written: no filtering — and no request to any host
 * the reader has not allowed for it (docs/page-external-hosts-ui.md). What it
 * is refused, the strip above it says, and offers to load.
 *
 * A page that does not ask for the theme gets nothing of it: white under a
 * light color scheme whatever the theme, because it is an ordinary page — a
 * dark parent would otherwise paint the canvas dark — and nothing is posted
 * to it. A page that asks (`followsTheme`) is drawn with the base stylesheet
 * on the theme's ground and follows every theme change live
 * (docs/tool-call-ui.md § Theme: a page that asks for it).
 *
 * A page that sends gets the bridge, and this is the app's side of it: every
 * send is answered, refused here or passed to the session's agent, and what
 * became of it is the line under the page (docs/tool-call-ui.md § Sending to
 * the agent).
 */
export function HtmlFrame({
	html,
	title,
	pageKey,
	page,
	onHeight,
	shown = true,
	className,
	boxRef,
	boxClassName,
	boxStyle,
}: Props) {
	const ref = useRef<HTMLIFrameElement>(null);
	const onHeightRef = useRef(onHeight);
	onHeightRef.current = onHeight;
	const sized = onHeight !== undefined;
	const sends = page !== undefined && page !== "" && sendsToAgent(html);
	const allowed = useAllowedPageHosts(pageKey);
	const themed = followsTheme(html);
	const source: Source = { html, title, pageKey, sized, sends, themed };
	const sender = usePageSender();
	const readOnly = useSessionView() !== null;
	// Read by the send handler, which outlives the render it was made in.
	const latest = useRef({ sender, readOnly, page, pageKey });
	latest.current = { sender, readOnly, page, pageKey };
	// A frame that opens after an allowance starts with it; one already open
	// keeps the document the reader has, until its own Load or Reload.
	const [doc, setDoc] = useState(() => drawn(source, 0, false));
	// The document of a themed page that has been shown: until then it is
	// hidden, so WebKit's white first paint of a `srcdoc` never flashes in a
	// dark app.
	const [shownId, setShownId] = useState<number | null>(null);
	const visible = !doc.source.themed || shownId === doc.id;
	/**
	 * Every send is answered: the bridge refuses none that it posts. Answered
	 * to the window that sent; a document that has since replaced it there
	 * ignores the answer, its ids being its own.
	 */
	function answerSend(
		{ id, action, data, active }: PageSendMessage,
		target: Window,
	) {
		const current = latest.current;
		const settle = startPageSend(current.pageKey, action);
		const refuse = (code: SendRefusal, message: string) => {
			target.postMessage(sendRefused(id, code, message), "*");
			settle({ state: "refused", action, code, message });
		};
		// In this order: whether the reader used the page says the most about
		// the press, and depends on nothing else.
		if (!active) return refuse("inactive", SEND_REFUSAL_MESSAGES.inactive);
		if (current.readOnly) {
			return refuse("readonly", SEND_REFUSAL_MESSAGES.readonly);
		}
		if (!current.sender || !current.page) {
			return refuse("failed", "This page can't send from here.");
		}
		if (current.sender.awaitingPermission) {
			return refuse("awaiting", SEND_REFUSAL_MESSAGES.awaiting);
		}
		if (useWSStore.getState().status !== "connected") {
			return refuse("offline", SEND_REFUSAL_MESSAGES.offline);
		}
		current.sender.send({ page: current.page, action, data }).then(
			() => {
				target.postMessage(sendAccepted(id), "*");
				settle({ state: "sent", action });
			},
			(error: unknown) => {
				// A permission request that arrived after the check above.
				if (isAwaitingPermissionRejection(error)) {
					refuse("awaiting", SEND_REFUSAL_MESSAGES.awaiting);
				} else {
					refuse(
						isInvalidParamsRejection(error) ? "invalid" : "failed",
						asError(error).message,
					);
				}
			},
		);
	}

	const reports = usePageReports(ref, {
		hosts: doc.hosts,
		allowed,
		onPageMessage: (data, pageWindow) => {
			// Only a page drawn to send: any other has no bridge, and no
			// page to name.
			const send = doc.source.sends ? readPageSend(data) : null;
			if (send) {
				answerSend(send, pageWindow);
				return;
			}
			const themeReport = doc.source.themed ? readPageThemeReport(data) : null;
			if (themeReport) {
				// Unconditionally on every ready: what was posted before may
				// have reached no listener, and a palette change keeps the
				// scheme, so comparing schemes would miss it.
				if (themeReport.type === PAGE_READY) postTheme();
				if (themeReport.scheme === useThemeStore.getState().resolvedMode) {
					setShownId(doc.id);
				}
				return;
			}
			if (
				data &&
				typeof data === "object" &&
				"type" in data &&
				data.type === HEIGHT_MESSAGE &&
				"height" in data &&
				typeof data.height === "number"
			) {
				onHeightRef.current?.(data.height);
			}
		},
	});
	const { clear } = reports;
	const { fresh } = useRawMediaSource(PROJECT_TARGET, false);

	const redraw = useCallback(
		(next: Source, byLoad: boolean) => {
			setDoc((current) => drawn(next, current.id + 1, byLoad));
			clear();
		},
		[clear],
	);
	// Another page is another document, and what the last one was refused is
	// not this one's. Adjusted during render, so no commit shows the old
	// document's strip over the new one.
	if (!sameSource(doc.source, source)) redraw(source, false);

	// Each document takes a capability with time left on it (`fresh`), so a
	// Reload after hours is not drawn under one that has expired. Failing, the
	// page is drawn without one, under a notice that says why.
	// biome-ignore lint/correctness/useExhaustiveDependencies: asked for once per document, which `doc.id` names
	useEffect(() => {
		if (doc.project !== undefined) return;
		const controller = new AbortController();
		const settle = (project: Project | null, projectError: Error | null) => {
			if (controller.signal.aborted) return;
			setDoc((current) =>
				current.id === doc.id
					? {
							...current,
							project,
							projectError,
							// Drawn now, so in the theme shown now: one that changed
							// while the capability was asked for went to no page.
							theme: current.source.themed ? currentPageTheme() : current.theme,
						}
					: current,
			);
		};
		fresh(controller.signal).then(
			({ src }) =>
				settle(
					{
						root: new URL(src, location.href).href,
						workDir: useWSStore.getState().workDir,
					},
					null,
				),
			(error: unknown) => settle(null, asError(error)),
		);
		return () => controller.abort();
	}, [doc.id]);

	const srcDoc = useMemo(
		() =>
			doc.project === undefined
				? null
				: wrapperDocument(doc.source, doc.theme, doc.hosts, doc.project),
		[doc],
	);

	const themeName = useThemeStore((s) => s.theme);
	const scheme = useThemeStore((s) => s.resolvedMode);
	/** The theme shown now, to a themed page and to its wrapper. */
	const postTheme = useCallback(() => {
		const wrapper = ref.current?.contentWindow;
		if (!wrapper) return;
		const now = currentPageTheme();
		wrapper.postMessage({ type: PAGE_FRAME_SCHEME, scheme: now.scheme }, "*");
		// `length` first: a cross-origin window throws on an index it has no
		// frame at, as a wrapper does until its page's frame is parsed.
		if (wrapper.length > 0) {
			wrapper[0].postMessage({ type: PAGE_THEME, ...now }, "*");
		}
	}, []);
	const themedRef = useRef(doc.source.themed);
	themedRef.current = doc.source.themed;
	// Before paint, so the frame element's new scheme and its wrapper's are
	// as close together as messages allow.
	// biome-ignore lint/correctness/useExhaustiveDependencies: posted whenever the theme changes, which these name
	useLayoutEffect(() => {
		if (themedRef.current) postTheme();
	}, [themeName, scheme]);
	// A custom theme that arrives, or is registered again, after the app
	// started changes the palette and nothing in the store.
	useEffect(
		() =>
			subscribeThemeRegistry(() => {
				if (themedRef.current) postTheme();
			}),
		[postTheme],
	);

	// Shown, ready or not, once it has had time to say so.
	useEffect(() => {
		if (srcDoc === null || !doc.source.themed) return;
		const id = doc.id;
		const timer = setTimeout(() => setShownId(id), THEMED_SHOW_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [srcDoc, doc.id, doc.source.themed]);

	// Where the Load was, so a keyboard or screen reader is not dropped to the
	// top of the screen. Once shown: a hidden frame takes no focus — and only
	// if focus is still where the Load left it, since a themed page may be
	// shown up to two seconds later, by when the reader may have gone on.
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!visible || !doc.byLoad) return;
		const active = document.activeElement;
		if (
			active === null ||
			active === document.body ||
			rootRef.current?.contains(active)
		) {
			ref.current?.focus();
		}
	}, [doc, visible]);

	return (
		<div ref={rootRef} className={className}>
			{shown && (
				<PageHostsStrip
					// Each document's strip is its own: reviewed, announced and
					// held afresh.
					key={doc.id}
					refusals={reports.refusals}
					allowed={allowed}
					link={reports.link}
					left={reports.left}
					onLoad={(hosts) => {
						allowPageHosts(pageKey, hosts);
						redraw(source, true);
					}}
					onReload={() => redraw(source, false)}
					onOpenLink={reports.openLink}
				/>
			)}
			{doc.projectError && (
				<PageNotice>
					Project files won't load on this page: {doc.projectError.message}
				</PageNotice>
			)}
			{/* `relative` for the shield, which covers the frame alone. A
			    themed page's ground, which shows while its frame is hidden. */}
			<div
				ref={boxRef}
				className={`relative ${doc.source.themed ? "bg-th-bg-primary" : ""} ${boxClassName ?? ""}`}
				style={boxStyle}
			>
				{/* A new frame for a new document, rather than a new `srcdoc`
				    in the old one, which would add a history entry that Back —
				    and the full-screen viewer's back-to-close — would step
				    through with nothing visible happening. */}
				{srcDoc !== null && (
					<iframe
						key={doc.id}
						ref={ref}
						title={doc.source.title}
						srcDoc={srcDoc}
						sandbox={sandboxOf(doc.source)}
						// A themed page's frame is the transcript's ground where
						// the page does not paint, and under the scheme shown, so
						// it never disagrees with its document's.
						className={`block h-full w-full border-0 ${doc.source.themed ? "bg-th-bg-primary" : "bg-white"}`}
						style={
							doc.source.themed
								? {
										colorScheme: scheme,
										visibility: visible ? undefined : "hidden",
									}
								: { colorScheme: "light" }
						}
					/>
				)}
				{/* Only a page that sends: under a layer a shielded page cannot
				    be pressed or scrolled, which for one that cannot send would
				    be a change with nothing to prevent. */}
				{srcDoc !== null && doc.source.sends && <FrameShield />}
			</div>
			{doc.source.sends && <PageSendLine pageKey={pageKey} />}
		</div>
	);
}
