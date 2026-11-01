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
	APP_FROM_PAGE,
	agentPageDocument,
	agentWrapperDocument,
	HTML_FRAME_SANDBOX,
	initialPageProject,
	type PageProject,
	usePageProject,
} from "../../lib/agentPage";
import {
	allowedPageHosts,
	allowPageHosts,
	useAllowedPageHosts,
} from "../../lib/pageHosts";
import { asError } from "../../utils/errorMessage";
import PageNotice from "../Media/PageNotice";
import { FrameShield } from "../ui/FrameShield";
import { PageHostsStrip } from "../ui/PageHostsStrip";

const HEIGHT_MESSAGE = "pockode:html-height";

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

function wrapperDocument(
	html: string,
	title: string,
	hosts: readonly string[],
	sized: boolean,
	project: PageProject | null,
) {
	const page = agentPageDocument(html, hosts, project, {
		after: sized ? `\n${HEIGHT_REPORTER}` : "",
	});
	return agentWrapperDocument(page, title, hosts, project);
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
	/**
	 * Undefined while the capability is being asked for, and the frame waits
	 * for it; null when there is none to be had, and the page is drawn as it
	 * was before it could reach the project.
	 */
	project: PageProject | null | undefined;
	/** Why there is no project to be had, when asking for it failed. */
	projectError: Error | null;
}

function drawn(source: Source, id: number, byLoad: boolean): DrawnDocument {
	return {
		id,
		source,
		hosts: [...allowedPageHosts(source.pageKey)].sort(),
		byLoad,
		project: initialPageProject(),
		projectError: null,
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
	const askProject = usePageProject();

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
		const settle = (
			project: PageProject | null,
			projectError: Error | null,
		) => {
			if (controller.signal.aborted) return;
			setDoc((current) =>
				current.id === doc.id ? { ...current, project, projectError } : current,
			);
		};
		askProject(controller.signal).then(
			(project) => settle(project, null),
			(error: unknown) => settle(null, asError(error)),
		);
		return () => controller.abort();
	}, [doc.id]);

	const srcDoc = useMemo(
		() =>
			doc.project === undefined
				? null
				: wrapperDocument(
						doc.source.html,
						doc.source.title,
						doc.hosts,
						doc.source.sized,
						doc.project,
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
			{doc.projectError && (
				<PageNotice>
					Project files won't load on this page: {doc.projectError.message}
				</PageNotice>
			)}
			<div
				ref={boxRef}
				className={`relative ${boxClassName ?? ""}`}
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
						sandbox={HTML_FRAME_SANDBOX}
						className="block h-full w-full border-0 bg-white"
						style={{ colorScheme: "light" }}
					/>
				)}
				{/* The strip above stays within reach: it is the app's own. */}
				{srcDoc !== null && <FrameShield />}
			</div>
		</div>
	);
}
