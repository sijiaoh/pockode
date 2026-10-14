import {
	type CSSProperties,
	type Ref,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePageReports } from "../../hooks/usePageReports";
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
import { PageHostsStrip } from "../ui/PageHostsStrip";

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

const HEIGHT_MESSAGE = "pockode:html-height";

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
 * the content is. Below the frame's height the scroll height is the frame's,
 * so it is read only past it, or a page could never shrink.
 */
const HEIGHT_REPORTER = `<script>(function(){var last=-1;function report(){var d=document.documentElement;var h=Math.ceil(d.scrollHeight>innerHeight?d.scrollHeight:d.getBoundingClientRect().height);if(h!==last){last=h;${APP_FROM_PAGE}.postMessage({type:"${HEIGHT_MESSAGE}",height:h},"*");}}new ResizeObserver(report).observe(document.documentElement);addEventListener("load",report);})();</script>`;

/**
 * The page as the frame draws it: the policy at byte 0, before anything the
 * agent wrote — a `srcdoc` document is never in quirks mode, so a doctype
 * after it changes nothing — then the reporter, so it hears what the head is
 * refused, then the page as written.
 */
function pageDocument(html: string, hosts: readonly string[], sized: boolean) {
	return `${pagePolicyMeta(hosts)}${pageReporterScript(APP_FROM_PAGE)}${html}${sized ? `\n${HEIGHT_REPORTER}` : ""}`;
}

/**
 * The document the page's frame sits in, which exists for its `frame-src`:
 * the browser checks the embedding document's policy on every navigation of a
 * frame, the ones the frame starts included, so the page cannot leave for a
 * host by navigating itself — by script, form, link or refresh. The app's own
 * document cannot be the embedder, being every page's at once.
 *
 * The page inherits this policy, as a `srcdoc` document does its parent's, so
 * it is the page's own: the two only ever differ by nothing.
 */
function wrapperDocument(
	html: string,
	title: string,
	hosts: readonly string[],
	sized: boolean,
) {
	return `${pagePolicyMeta(hosts)}<script>${LEFT_LISTENER}</script>${WRAPPER_STYLE}<iframe title="${escapeAttribute(title)}" sandbox="${HTML_FRAME_SANDBOX}" srcdoc="${escapeAttribute(pageDocument(html, hosts, sized))}"></iframe>`;
}

/** What a page is drawn from; another of any of these is another document. */
interface Source {
	html: string;
	title: string;
	pageKey: string;
	sized: boolean;
}

/** Which document is in the frame, and the hosts its policy allows. */
interface DrawnDocument {
	id: number;
	source: Source;
	hosts: readonly string[];
	/** Drawn by a Load, which hands the frame the focus. */
	byLoad: boolean;
}

function drawn(source: Source, id: number, byLoad: boolean): DrawnDocument {
	return {
		id,
		source,
		hosts: [...allowedPageHosts(source.pageKey)].sort(),
		byLoad,
	};
}

function sameSource(a: Source, b: Source): boolean {
	return (
		a.html === b.html &&
		a.title === b.title &&
		a.pageKey === b.pageKey &&
		a.sized === b.sized
	);
}

interface Props {
	html: string;
	title: string;
	/**
	 * The page the reader's allowance is for: one `html_render` call, whichever
	 * view it is drawn in.
	 */
	pageKey: string;
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
 * An agent's HTML page, as written: no base stylesheet, no filtering — and no
 * request to any host the reader has not allowed for it
 * (docs/page-external-hosts-ui.md). What it is refused, the strip above it
 * says, and offers to load. White under a light color scheme whatever the
 * theme, because it is an ordinary page — a dark parent would otherwise paint
 * the canvas dark.
 */
export function HtmlFrame({
	html,
	title,
	pageKey,
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
	const allowed = useAllowedPageHosts(pageKey);
	const source: Source = { html, title, pageKey, sized };
	// A frame that opens after an allowance starts with it; one already open
	// keeps the document the reader has, until its own Load or Reload.
	const [doc, setDoc] = useState(() => drawn(source, 0, false));
	const reports = usePageReports(ref, {
		hosts: doc.hosts,
		allowed,
		onPageMessage: (data) => {
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

	const srcDoc = useMemo(
		() =>
			wrapperDocument(
				doc.source.html,
				doc.source.title,
				doc.hosts,
				doc.source.sized,
			),
		[doc],
	);

	// Where the Load was, so a keyboard or screen reader is not dropped to the
	// top of the screen.
	useEffect(() => {
		if (doc.byLoad) ref.current?.focus();
	}, [doc]);

	return (
		<div className={className}>
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
			<div ref={boxRef} className={boxClassName} style={boxStyle}>
				{/* A new frame for a new document, rather than a new `srcdoc`
				    in the old one, which would add a history entry that Back —
				    and the full-screen viewer's back-to-close — would step
				    through with nothing visible happening. */}
				<iframe
					key={doc.id}
					ref={ref}
					title={doc.source.title}
					srcDoc={srcDoc}
					sandbox={HTML_FRAME_SANDBOX}
					className="block h-full w-full border-0 bg-white"
					style={{ colorScheme: "light" }}
				/>
			</div>
		</div>
	);
}
