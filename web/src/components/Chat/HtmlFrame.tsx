import { type CSSProperties, useEffect, useRef } from "react";

/**
 * The one security floor under an agent's page. Scripts run and links open in
 * a new tab, and nothing more:
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
 * Appended to the page so it can say how tall it is: a sandboxed frame has an
 * opaque origin, so its document cannot be measured from outside. The
 * document element rather than the body, because a srcdoc document is never in
 * quirks mode, so it is as tall as its content and not as the frame — unless
 * the page pins it to the frame (`html, body { height: 100% }`, common in
 * generated pages), when only its overflow, the scroll height, says how tall
 * the content is. Below the frame's height the scroll height is the frame's,
 * so it is read only past it, or a page could never shrink.
 */
const HEIGHT_REPORTER = `<script>(function(){var last=-1;function report(){var d=document.documentElement;var h=Math.ceil(d.scrollHeight>innerHeight?d.scrollHeight:d.getBoundingClientRect().height);if(h!==last){last=h;parent.postMessage({type:"${HEIGHT_MESSAGE}",height:h},"*");}}new ResizeObserver(report).observe(document.documentElement);addEventListener("load",report);})();</script>`;

interface Props {
	html: string;
	title: string;
	/** The page's height whenever it changes; the frame is then sized by it. */
	onHeight?: (height: number) => void;
	className?: string;
	style?: CSSProperties;
}

/**
 * An agent's HTML page, as written: no base stylesheet, no CSP, no filtering.
 * White under a light color scheme whatever the theme, because it is an
 * ordinary page — a dark parent would otherwise paint the canvas dark.
 */
export function HtmlFrame({ html, title, onHeight, className, style }: Props) {
	const ref = useRef<HTMLIFrameElement>(null);
	const onHeightRef = useRef(onHeight);
	onHeightRef.current = onHeight;
	const sized = onHeight !== undefined;

	useEffect(() => {
		if (!sized) return;
		const onMessage = (event: MessageEvent) => {
			// Only this frame's own page: every frame posts to the same window.
			if (!ref.current || event.source !== ref.current.contentWindow) return;
			const data: unknown = event.data;
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
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [sized]);

	return (
		<iframe
			ref={ref}
			title={title}
			srcDoc={sized ? `${html}\n${HEIGHT_REPORTER}` : html}
			sandbox={HTML_FRAME_SANDBOX}
			className={`block w-full border-0 bg-white ${className ?? ""}`}
			style={{ colorScheme: "light", ...style }}
		/>
	);
}
