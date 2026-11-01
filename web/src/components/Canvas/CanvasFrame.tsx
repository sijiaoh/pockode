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

/**
 * The page's own window, past the wrapper: transparent, so the page's root —
 * `--pk-bg` from the base stylesheet — is what shows, and under the theme's
 * scheme, so nothing white flashes in a dark app while it loads.
 */
function wrapperStyle(scheme: CanvasTheme["scheme"]): string {
	return `<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent;color-scheme:${scheme}}iframe{display:block;width:100%;height:100%;border:0}</style>`;
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

function wrapperDocument(doc: CanvasDocument, project: PageProject | null) {
	const page = agentPageDocument(doc.state.html ?? "", doc.hosts, project, {
		before: `${canvasBridgeScript(APP_FROM_PAGE)}${canvasBaseStylesheet(doc.theme)}`,
	});
	return agentWrapperDocument(page, doc.title, doc.hosts, project, {
		style: wrapperStyle(doc.theme.scheme),
		sandbox: CANVAS_FRAME_SANDBOX,
	});
}

/**
 * In each dimension the larger of the canvas area and the size the revision
 * was drawn for (§5): a page drawn for a larger screen keeps its size and the
 * area scrolls to it, never scaled.
 */
function frameSize(drawnFor: CanvasSize | undefined) {
	return {
		width: drawnFor ? `max(100%, ${drawnFor.width}px)` : "100%",
		height: drawnFor ? `max(100%, ${drawnFor.height}px)` : "100%",
	};
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
	/** The canvas area: what scrolls, and what the size is measured from. */
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
	areaRef,
	className,
	title = "Canvas",
}: Props) {
	const ref = useRef<HTMLIFrameElement>(null);
	const pageKey = `canvas:${sessionId}`;
	const allowed = useAllowedPageHosts(pageKey);
	const [doc, setDoc] = useState<CanvasDocument | null>(null);
	/** What the page shows now, patches included: its size follows it. */
	const [shownState, setShownState] = useState<CanvasState | null>(null);
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
				setShownState(state);
				// What the last document was refused is not this one's.
				clear();
				// Its focused field went with it.
				if (editable.current) {
					editable.current = false;
					latest.current.onEditableFocus?.(false);
				}
			},
			patched: setShownState,
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
				: wrapperDocument(doc, doc.project),
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
			<div ref={areaRef} className="min-h-0 flex-1 overflow-auto">
				<div style={frameSize(shownState?.drawn_for)}>
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
		</div>
	);
}
