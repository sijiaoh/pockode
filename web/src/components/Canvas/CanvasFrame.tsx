import {
	type Ref,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePageReports } from "../../hooks/usePageReports";
import { isFreshCapability } from "../../hooks/useRawMediaSource";
import {
	APP_FROM_PAGE,
	agentPageDocument,
	agentWrapperDocument,
	CANVAS_FRAME_SANDBOX,
	initialPageProject,
	type PageProject,
	pageHtml,
	pageWindowOf,
	usePageProject,
} from "../../lib/agentPage";
import {
	type CanvasAppMessage,
	type CanvasReadOnly,
	type CanvasTheme,
	canvasBaseStylesheet,
	canvasBridgeScript,
	canvasThemeFrom,
	READONLY_REFUSAL_MESSAGES,
	readCanvasPageMessage,
	SEND_REFUSAL_MESSAGES,
	type SendRefusal,
} from "../../lib/canvasBridge";
import { CanvasRedraw } from "../../lib/canvasRedraw";
import {
	allowedPageHosts,
	allowPageHosts,
	useAllowedPageHosts,
} from "../../lib/pageHosts";
import type { CanvasActionInput } from "../../lib/rpc";
import { useThemeStore } from "../../lib/themeStore";
import { isInvalidParamsRejection, useWSStore } from "../../lib/wsStore";
import type { CanvasSize, CanvasState } from "../../types/canvas";
import { asError } from "../../utils/errorMessage";
import PageNotice from "../Media/PageNotice";
import { PageHostsStrip } from "../ui/PageHostsStrip";

/** Why sending from the page is impossible right now, as the bridge is told. */
export type CanvasSendBlock = "permission";

/** The theme the app shows now, as the page's variables take it (§3.3). */
function currentTheme(): CanvasTheme {
	return canvasThemeFrom(
		getComputedStyle(document.documentElement),
		useThemeStore.getState().resolvedMode,
	);
}

/** The app telling a wrapper the size the page in it is shown at. */
const FRAME_SIZE = "pockode:canvas-frame-size";

/**
 * The app telling a wrapper how much of the bottom of the area something of
 * the app's own floats over — the expanded composer (§2).
 */
const FRAME_COVERED = "pockode:canvas-frame-covered";

/** The size a revision is shown at (§5); none drawn for fills the area. */
function shownSize(drawnFor: CanvasSize | undefined): CanvasSize {
	return drawnFor ?? { width: 0, height: 0 };
}

/**
 * The page's own window, past the wrapper: transparent, so the page's root —
 * `--pk-bg` from the base stylesheet — is what shows, and under the theme's
 * scheme, so nothing white flashes in a dark app while it loads.
 *
 * The wrapper is also what scrolls to a page drawn for a larger screen (§5):
 * the page's frame is in each dimension the larger of the wrapper and the
 * drawn size, never scaled. Not the canvas area around the wrapper: a frame
 * moved by a scroller of the app's own document makes Chromium on some
 * tablets (Huawei Browser) drop the app's bars around it, white or blank, for
 * as long as the scroll lasts — moved inside the wrapper it does not. A patch
 * may bring another size, which the app posts here (`FRAME_SIZE`): the page
 * keeps its document, as it does through any patch.
 *
 * What the app floats over the bottom of the area (`FRAME_COVERED`) is room
 * the wrapper scrolls on past the page, so the page's bottom can be brought
 * above it. Room after the page's frame, not a shorter frame: the page's
 * viewport stays the size it was drawn for, and nothing goes into the page.
 */
function wrapperStyle(
	scheme: CanvasTheme["scheme"],
	size: CanvasSize,
	covered: number,
): string {
	return `<style>:root{--pk-frame-width:${size.width}px;--pk-frame-height:${size.height}px;--pk-covered:${covered}px}html{overflow:auto}html,body{margin:0;height:100%;background:transparent;color-scheme:${scheme}}iframe{display:block;width:max(100%,var(--pk-frame-width));height:max(100%,var(--pk-frame-height));border:0}body::after{content:"";display:block;height:var(--pk-covered)}</style><script>addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d)return;var s=document.documentElement.style;if(d.type==="${FRAME_SIZE}"){s.setProperty("--pk-frame-width",Number(d.width)+"px");s.setProperty("--pk-frame-height",Number(d.height)+"px");}else if(d.type==="${FRAME_COVERED}"){s.setProperty("--pk-covered",Number(d.covered)+"px");}});</script>`;
}

/** Which document is in the frame, and what it was drawn under. */
interface CanvasDocument {
	id: number;
	state: CanvasState;
	title: string;
	hosts: readonly string[];
	theme: CanvasTheme;
	/** Drawn by a Load, which hands the frame the focus. */
	byLoad: boolean;
	/** As `HtmlFrame`'s: undefined while asked for, null when there is none. */
	project: PageProject | null | undefined;
	projectError: Error | null;
}

function wrapperDocument(
	doc: CanvasDocument,
	project: PageProject | null,
	covered: number,
) {
	const page = agentPageDocument(doc.state.html ?? "", doc.hosts, project, {
		before: `${canvasBridgeScript(APP_FROM_PAGE)}${canvasBaseStylesheet(doc.theme)}`,
	});
	return agentWrapperDocument(page, doc.title, doc.hosts, project, {
		style: wrapperStyle(
			doc.theme.scheme,
			shownSize(doc.state.drawn_for),
			covered,
		),
		sandbox: CANVAS_FRAME_SANDBOX,
	});
}

function post(page: Window | null, message: CanvasAppMessage) {
	page?.postMessage(message, "*");
}

interface Props {
	/**
	 * The session the canvas is; its hosts allowance is the session's. One
	 * live frame per session: key it by the session, since the revision it
	 * records as shown is that session's. A read-only frame is keyed by the
	 * revision it shows instead, so each is drawn whole (§15.2).
	 */
	sessionId: string;
	/** The revision to show; revision 0 draws nothing. */
	canvas: CanvasState;
	/**
	 * Sends what the user did on the page; the frame fills in the revision it
	 * shows. `useChatMessages(...).sendCanvasAction`, which adds the session
	 * and the device's canvas size.
	 */
	onSend: (input: CanvasActionInput) => Promise<void>;
	/**
	 * A frame of the history view, never the live canvas (§13.5, §15.4): every
	 * send from it is refused with `readonly`, in the wording for the page it
	 * shows. Null for the live canvas.
	 */
	readOnly?: CanvasReadOnly | null;
	/** Sending is refused for this reason, decided from the turn (§10.3). */
	sendBlocked?: CanvasSendBlock | null;
	/** A send from the page was refused before it reached the server. */
	onSendRefused?: (code: SendRefusal) => void;
	/**
	 * Whether an editable element in the page has focus, which the size rule
	 * needs (§5) and only the page can see.
	 */
	onEditableFocus?: (editable: boolean) => void;
	/** False while the canvas is hidden under chat view, as `HtmlFrame`'s. */
	shown?: boolean;
	/**
	 * How much of the bottom of the area the app floats something over — the
	 * expanded composer (§2): the frame scrolls on that far past the page, so
	 * all of it can be brought above. The area and the page's viewport keep
	 * their size, and with them the canvas size (§5).
	 */
	covered?: number;
	/** The canvas area, which the frame fills: what the size is measured from. */
	areaRef?: Ref<HTMLDivElement>;
	className?: string;
	title?: string;
}

/**
 * The canvas page (docs/canvas-ui.md §4): an agent's page in the double frame
 * `HtmlFrame` draws, with the bridge and the base stylesheet before the
 * agent's markup, redrawn on every revision — in place when it can (§8.3) —
 * and the app's side of the bridge: sends answered, the theme posted.
 */
export function CanvasFrame({
	sessionId,
	canvas,
	onSend,
	readOnly = null,
	sendBlocked = null,
	onSendRefused,
	onEditableFocus,
	shown = true,
	covered = 0,
	areaRef,
	className,
	title = "Canvas",
}: Props) {
	const ref = useRef<HTMLIFrameElement>(null);
	const pageKey = `canvas:${sessionId}`;
	const allowed = useAllowedPageHosts(pageKey);
	const [doc, setDoc] = useState<CanvasDocument | null>(null);
	const askProject = usePageProject();

	// Read by the bridge's handlers, which outlive the render they were made in.
	const latest = useRef({
		doc,
		readOnly,
		sendBlocked,
		onSend,
		onSendRefused,
		onEditableFocus,
		pageKey,
		title,
	});
	latest.current = {
		doc,
		readOnly,
		sendBlocked,
		onSend,
		onSendRefused,
		onEditableFocus,
		pageKey,
		title,
	};
	const coveredRef = useRef(covered);
	coveredRef.current = covered;
	const canvasRef = useRef(canvas);
	canvasRef.current = canvas;
	const redrawRef = useRef<CanvasRedraw | null>(null);
	const byLoad = useRef(false);
	const editable = useRef(false);

	const reports = usePageReports(ref, {
		hosts: doc?.hosts ?? [],
		allowed,
		onPageMessage: (data) => {
			const message = readCanvasPageMessage(data);
			if (message === null) return;
			if (message.type === "pockode:canvas-patched") {
				redrawRef.current?.patched(message.revision, message.ok);
			} else if (message.type === "pockode:canvas-ready") {
				pageReady();
			} else if (message.type === "pockode:canvas-focus") {
				editable.current = message.editable;
				latest.current.onEditableFocus?.(message.editable);
			} else {
				answerSend(message.id, message.action, message.data);
			}
		},
	});
	const { clear } = reports;

	/**
	 * The bridge has started on a parsed page. The first time for a document,
	 * that is the document drawn; a later time is the page loaded again by
	 * itself, which shows the revision it was drawn with, not the patches since
	 * — so it is drawn whole, rather than sends from it claiming a revision it
	 * does not show. Either way it has missed what was posted before.
	 */
	function pageReady() {
		const redraw = redrawRef.current;
		const drawn = latest.current.doc?.state.revision;
		if (redraw && drawn !== undefined && redraw.shown !== drawn) {
			redraw.redraw();
			return;
		}
		postTheme();
		sendable();
		postCovered();
		redraw?.loaded();
	}

	/** Every send is answered: the bridge refuses none that it posts (§8.1). */
	function answerSend(id: string, action: string, data: unknown) {
		const page = pageWindowOf(ref.current);
		const current = latest.current;
		const refuse = (code: SendRefusal, message: string) =>
			post(page, {
				type: "pockode:canvas-send-result",
				id,
				ok: false,
				code,
				message,
			});
		const refuseHere = (code: SendRefusal, message: string) => {
			refuse(code, message);
			current.onSendRefused?.(code);
		};
		// Read-only first: it does not depend on anything the bridge was told,
		// and a send on load arrives before it could be told anything.
		if (current.readOnly) {
			return refuseHere(
				"readonly",
				READONLY_REFUSAL_MESSAGES[current.readOnly],
			);
		}
		if (current.sendBlocked === "permission") {
			return refuseHere("permission", SEND_REFUSAL_MESSAGES.permission);
		}
		if (useWSStore.getState().status !== "connected") {
			return refuseHere("offline", SEND_REFUSAL_MESSAGES.offline);
		}
		const revision = redrawRef.current?.shown ?? 0;
		current.onSend({ action, data, revision }).then(
			() => post(page, { type: "pockode:canvas-send-result", id, ok: true }),
			(error: unknown) =>
				refuse(
					isInvalidParamsRejection(error) ? "invalid" : "failed",
					asError(error).message,
				),
		);
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: one redraw for the frame's life; what it reads changes through refs
	useEffect(() => {
		const redraw = new CanvasRedraw({
			draw: (state) => {
				const loaded = byLoad.current;
				byLoad.current = false;
				setDoc((current) => ({
					id: (current?.id ?? 0) + 1,
					state,
					// The page's own; a later title is the next drawing's.
					title: latest.current.title,
					hosts: [...allowedPageHosts(latest.current.pageKey)].sort(),
					theme: currentTheme(),
					byLoad: loaded,
					project: initialPageProject(),
					projectError: null,
				}));
				// What the last document was refused is not this one's.
				clear();
				// Its focused field went with it.
				if (editable.current) {
					editable.current = false;
					latest.current.onEditableFocus?.(false);
				}
			},
			// The size follows the revision shown, a patched one included (§5);
			// a drawn one has it in its wrapper already.
			patched: (state) => {
				const { width, height } = shownSize(state.drawn_for);
				ref.current?.contentWindow?.postMessage(
					{ type: FRAME_SIZE, width, height },
					"*",
				);
			},
			patch: (patch) => {
				const page = pageWindowOf(ref.current);
				if (!page) return false;
				const project = latest.current.doc?.project ?? null;
				post(page, {
					type: "pockode:canvas-patch",
					...patch,
					ops: patch.ops.map((op) =>
						op.op === "remove"
							? op
							: { ...op, html: pageHtml(op.html, project) },
					),
				});
				return true;
			},
			patchable: () => {
				const project = latest.current.doc?.project;
				if (project === undefined) return false;
				// A document drawn offline reaches no project, and has none to
				// lose; once connected, the next drawing takes a capability.
				return project
					? isFreshCapability(project.expiresAt)
					: useWSStore.getState().status !== "connected";
			},
		});
		redrawRef.current = redraw;
		redraw.show(canvasRef.current);
		return () => {
			redraw.dispose();
			redrawRef.current = null;
		};
	}, []);

	useEffect(() => {
		redrawRef.current?.show(canvas);
	}, [canvas]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: asked for once per document, which `doc.id` names
	useEffect(() => {
		if (!doc || doc.project !== undefined) return;
		const controller = new AbortController();
		const settle = (
			project: PageProject | null,
			projectError: Error | null,
		) => {
			if (controller.signal.aborted) return;
			setDoc((current) =>
				current?.id === doc.id
					? { ...current, project, projectError }
					: current,
			);
		};
		askProject(controller.signal).then(
			(project) => settle(project, null),
			(error: unknown) => settle(null, asError(error)),
		);
		return () => controller.abort();
	}, [doc?.id]);

	const sendable = useCallback(() => {
		const { readOnly, sendBlocked } = latest.current;
		post(pageWindowOf(ref.current), {
			type: "pockode:canvas-sendable",
			sendable: !readOnly && sendBlocked === null,
			...(!readOnly && sendBlocked ? { reason: sendBlocked } : {}),
		});
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: posted whenever what it says changes, which these name
	useEffect(sendable, [readOnly, sendBlocked]);

	// Also on every page ready: what changed while the wrapper was loading
	// was posted to a document that was not listening yet.
	const postCovered = useCallback(() => {
		ref.current?.contentWindow?.postMessage(
			{ type: FRAME_COVERED, covered: coveredRef.current },
			"*",
		);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: posted whenever it changes, which `covered` names
	useEffect(postCovered, [covered]);

	const theme = useThemeStore((s) => s.theme);
	const scheme = useThemeStore((s) => s.resolvedMode);
	const postTheme = useCallback(() => {
		post(pageWindowOf(ref.current), {
			type: "pockode:canvas-theme",
			...currentTheme(),
		});
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: posted whenever the theme changes, which these name
	useEffect(postTheme, [theme, scheme]);

	const srcDoc = useMemo(
		() =>
			doc === null || doc.project === undefined || !doc.state.html
				? null
				: // The wrapper starts at the cover there is now; later ones are
					// posted to it, without drawing the page again.
					wrapperDocument(doc, doc.project, coveredRef.current),
		[doc],
	);

	// Where the Load was, so a keyboard or screen reader is not dropped to the
	// top of the screen.
	useEffect(() => {
		if (doc?.byLoad) ref.current?.focus();
	}, [doc]);

	const redrawWhole = (loaded: boolean) => {
		byLoad.current = loaded;
		redrawRef.current?.redraw();
	};

	return (
		<div className={`flex min-h-0 flex-col ${className ?? ""}`}>
			{shown && doc && (
				<PageHostsStrip
					key={doc.id}
					refusals={reports.refusals}
					allowed={allowed}
					link={reports.link}
					left={reports.left}
					onLoad={(hosts) => {
						allowPageHosts(pageKey, hosts);
						redrawWhole(true);
					}}
					onReload={() => redrawWhole(false)}
					onOpenLink={reports.openLink}
				/>
			)}
			{doc?.projectError && (
				<PageNotice>
					Project files won't load on this page: {doc.projectError.message}
				</PageNotice>
			)}
			{/* Never a scroller: the frame always fills it, and what is larger
			    than it scrolls inside the wrapper (see `wrapperStyle`). */}
			<div ref={areaRef} className="min-h-0 flex-1">
				{/* A new frame for a new document, as in `HtmlFrame`: a new
				    `srcdoc` in the old one would add a history entry. */}
				{srcDoc !== null && (
					<iframe
						key={doc?.id}
						ref={ref}
						title={doc?.title}
						srcDoc={srcDoc}
						sandbox={CANVAS_FRAME_SANDBOX}
						className="block h-full w-full border-0 bg-th-bg-primary"
						style={{ colorScheme: scheme }}
					/>
				)}
			</div>
		</div>
	);
}
