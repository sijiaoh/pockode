import { Image } from "lucide-react";
import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useInView } from "../../hooks/useInView";
import {
	blockedImageHost,
	type FromFrame,
	frameHostsKey,
	mermaidFrameDocument,
	newFrameSecrets,
	readFrameHandshake,
	readFrameMessage,
	type ToFrame,
} from "../../lib/mermaidFrame";
import { loadMermaidSource } from "../../lib/mermaidSource";
import { subscribeToDarkMode } from "../../lib/shikiUtils";
import AttachmentChip from "./AttachmentChip";
import { CodeBlock } from "./CodeBlock";
import { MarkdownImageContext } from "./MarkdownImage";

/**
 * The image hosts each diagram was last drawn with, so it needs no second tap
 * wherever it mounts again — as `MarkdownImage` remembers a URL. In memory
 * only, so a reload asks again.
 */
const loadedDiagramHosts = new Map<string, readonly string[]>();

/**
 * How long a frame has to say `ready` before the diagram falls back to its
 * source. Its first script is a few lines and needs nothing fetched, so only a
 * frame that cannot run at all — a policy the page itself is served with also
 * binds a `srcdoc` frame — takes anywhere near this long.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

function rootClassName() {
	return document.documentElement.className;
}

/**
 * What the frame takes from the page to draw as the page would: Mermaid's
 * theme, and the font and text colour anything Mermaid leaves unstyled
 * inherits. Read again whenever the root's classes change, which is how the
 * app switches both light and dark and its colour theme.
 */
function useFrameAppearance() {
	const className = useSyncExternalStore(
		subscribeToDarkMode,
		rootClassName,
		() => "",
	);
	// Memoised: reading computed style forces a style recalculation, and a
	// message streaming in renders every diagram in it once per chunk.
	return useMemo(() => {
		const dark = className.split(/\s+/).includes("dark");
		const style = getComputedStyle(document.documentElement);
		return {
			theme: dark ? ("dark" as const) : ("default" as const),
			colorScheme: dark ? ("dark" as const) : ("light" as const),
			fontFamily: style.fontFamily,
			color: style.getPropertyValue("--th-text-primary").trim(),
		};
	}, [className]);
}

/** The image hosts a frame was refused, and the code it was drawing then. */
interface Refusals {
	code: string;
	hosts: ReadonlySet<string>;
}

const NO_REFUSALS: Refusals = { code: "", hosts: new Set() };

/** The port of the document now in the frame, and the hosts it allows. */
interface Connection {
	id: number;
	hosts: string;
}

/**
 * A ```` ```mermaid ```` block, drawn inside a sandboxed frame whose policy
 * refuses every request, so whatever its source says, nothing external loads
 * until the reader allows it — the hosts of the images it was refused, with the
 * same allowance as a Markdown image
 * (docs/markdown-images-ui.md#diagrams-draw-in-a-sealed-frame).
 */
export function MermaidDiagram({ code }: { code: string }) {
	const { allowedHosts, allowHost } = useContext(MarkdownImageContext);
	const { theme, colorScheme, fontFamily, color } = useFrameAppearance();
	// Each frame runs its own Mermaid, so one is only started once the reader
	// is near it, as an image is only read then.
	const { ref: inViewRef, inView } = useInView<HTMLElement>();
	const wrapperRef = useRef<HTMLElement | null>(null);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [secrets] = useState(newFrameSecrets);
	const [refusals, setRefusals] = useState<Refusals>(NO_REFUSALS);
	const [connection, setConnection] = useState<Connection | null>(null);
	const [greetedBy, setGreetedBy] = useState<string | null>(null);
	const nextConnectionId = useRef(0);
	const [drawnIn, setDrawnIn] = useState<number | null>(null);
	const [failed, setFailed] = useState(false);
	const [height, setHeight] = useState(0);
	const [loadPresses, setLoadPresses] = useState(0);
	const portRef = useRef<MessagePort | null>(null);

	// Held on the rule `MarkdownContent` holds its allowance on: a diagram
	// streaming in keeps what it was refused, and a host that swaps in another
	// text without remounting this does not offer the old diagram's hosts.
	const blocked = code.startsWith(refusals.code)
		? refusals.hosts
		: NO_REFUSALS.hosts;
	// Only what the frame was refused is ever allowed in it: an allowance the
	// reader gave in this text for some other image reaches the diagram only
	// once the diagram is found to need it.
	const imageHosts = useMemo(() => {
		const hosts = new Set(loadedDiagramHosts.get(code));
		for (const host of blocked) if (allowedHosts.has(host)) hosts.add(host);
		return [...hosts].sort();
	}, [code, blocked, allowedHosts]);
	const pending = [...blocked].filter((host) => !imageHosts.includes(host));
	// The policy is fixed when the document loads, so allowing a host is a new
	// document; nothing else changes it, so a diagram streaming in keeps one.
	const hostsKey = frameHostsKey(imageHosts);
	const srcDoc = useMemo(
		() => mermaidFrameDocument(secrets, hostsKey ? hostsKey.split(" ") : []),
		[secrets, hostsKey],
	);
	// A new document has neither greeted nor connected, even when an earlier
	// one with the same hosts did — a key that goes A, then "", then A again
	// would otherwise skip the timeout and draw over a blank frame. Adjusted
	// during render, so no commit in between still reads the old document's.
	const [documentHosts, setDocumentHosts] = useState(hostsKey);
	if (documentHosts !== hostsKey) {
		setDocumentHosts(hostsKey);
		setGreetedBy(null);
		setConnection(null);
	}

	// Read by the port's handler, which outlives the render it was made in: a
	// document that names other hosts is one a Load has already replaced, and
	// its late answers are not this diagram's.
	const wantedHosts = useRef(hostsKey);
	const currentCode = useRef(code);
	useLayoutEffect(() => {
		wantedHosts.current = hostsKey;
		currentCode.current = code;
	});

	const post = useCallback((message: ToFrame) => {
		portRef.current?.postMessage(message);
	}, []);

	useEffect(() => {
		const ownHostname = window.location.hostname;
		const { token } = secrets;
		// The code a diagram streaming in was last remembered by, so the record
		// keeps only its latest version rather than one per chunk.
		let remembered: string | null = null;

		function onPortMessage(id: number, hosts: string, message: FromFrame) {
			switch (message.type) {
				case "rendered": {
					setDrawnIn(id);
					setFailed(false);
					setHeight(message.height);
					if (hosts !== "") {
						if (remembered !== null && message.code.startsWith(remembered)) {
							loadedDiagramHosts.delete(remembered);
						}
						loadedDiagramHosts.set(message.code, hosts.split(" "));
						remembered = message.code;
					}
					break;
				}
				case "size":
					setHeight(message.height);
					break;
				case "error":
					setFailed(true);
					break;
				case "blocked": {
					const host = blockedImageHost(message.url, ownHostname);
					if (host === null) break;
					setRefusals((current) => {
						const code = currentCode.current;
						const hosts = code.startsWith(current.code)
							? current.hosts
							: NO_REFUSALS.hosts;
						return { code, hosts: new Set(hosts).add(host) };
					});
					break;
				}
				case "link": {
					// A diagram's link is a link the agent wrote, as in the text
					// around it: opened on the reader's tap, never in the frame.
					let url: URL;
					try {
						url = new URL(message.href);
					} catch {
						break;
					}
					if (url.protocol === "http:" || url.protocol === "https:") {
						window.open(url.href, "_blank", "noopener,noreferrer");
					}
					break;
				}
				case "escape":
					// A key pressed in the frame never reaches the page, where the
					// sheet or overlay it means to close is listening.
					frameRef.current?.dispatchEvent(
						new KeyboardEvent("keydown", {
							key: "Escape",
							bubbles: true,
							cancelable: true,
						}),
					);
					break;
			}
		}

		function onWindowMessage(event: MessageEvent) {
			const frame = frameRef.current;
			if (!frame || event.source !== frame.contentWindow) return;
			if (event.origin !== "null") return;
			const handshake = readFrameHandshake(event.data, event.ports, token);
			if (!handshake) return;
			const { port, hosts } = handshake;
			// Every load of the frame says ready again — a new policy, or the
			// browser reloading a frame moved in the DOM — and is drawn afresh.
			portRef.current?.close();
			portRef.current = port;
			nextConnectionId.current += 1;
			const id = nextConnectionId.current;
			setGreetedBy(hosts);
			port.onmessage = (portEvent) => {
				if (id !== nextConnectionId.current) return;
				if (hosts !== wantedHosts.current) return;
				const message = readFrameMessage(portEvent.data);
				if (message) onPortMessage(id, hosts, message);
			};
			loadMermaidSource().then(
				(source) => {
					if (portRef.current !== port) return;
					port.postMessage({ type: "script", source } satisfies ToFrame);
					setConnection({ id, hosts });
				},
				() => setFailed(true),
			);
		}
		window.addEventListener("message", onWindowMessage);
		return () => {
			window.removeEventListener("message", onWindowMessage);
			portRef.current?.close();
			portRef.current = null;
			setConnection(null);
		};
	}, [secrets]);

	const connectedId =
		connection !== null && connection.hosts === hostsKey ? connection.id : null;
	const connected = connectedId !== null;
	// Keyed by the connection too: a frame reloaded with the same document is
	// a new, empty one.
	useEffect(() => {
		if (connectedId === null) return;
		post({ type: "render", code, theme, colorScheme, fontFamily, color });
	}, [connectedId, code, theme, colorScheme, fontFamily, color, post]);

	// No silent "Loading diagram..." for good: a frame that never comes up
	// shows the source, as a diagram Mermaid cannot draw does. Only the frame's
	// own start is timed, not Mermaid's chunk, which a slow network may take
	// longer than this to bring.
	const greeted = greetedBy === hostsKey;
	useEffect(() => {
		if (!inView || greeted) return;
		const timer = setTimeout(() => setFailed(true), HANDSHAKE_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [inView, greeted]);

	const ref = useCallback(
		(node: HTMLElement | null) => {
			wrapperRef.current = node;
			inViewRef(node);
		},
		[inViewRef],
	);
	// Where the Load was, so a keyboard or screen reader is not dropped to the
	// top of the page.
	// Counted rather than a flag, so a second Load, for hosts the redrawn
	// diagram was then refused, takes the focus back too.
	useEffect(() => {
		if (loadPresses > 0) wrapperRef.current?.focus();
	}, [loadPresses]);

	const drawn = !failed && connected && drawnIn === connectedId;
	const named = pending.join(", ");
	return (
		<figure
			ref={ref}
			// Named, since a Load hands it the focus while its frame is hidden.
			aria-label="Mermaid diagram"
			tabIndex={loadPresses > 0 ? -1 : undefined}
			className={
				loadPresses > 0
					? "mermaid-diagram rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					: "mermaid-diagram"
			}
		>
			{failed ? (
				<CodeBlock code={code} language="mermaid" />
			) : (
				!drawn && <div className="mermaid-placeholder">Loading diagram...</div>
			)}
			{/* Kept mounted while it is not shown, so a diagram that streams
			    out of an error draws without loading Mermaid again. */}
			{inView && (
				<iframe
					ref={frameRef}
					title="Mermaid diagram"
					sandbox="allow-scripts"
					srcDoc={srcDoc}
					referrerPolicy="no-referrer"
					className="block w-full border-0"
					style={{ height: drawn ? height : 0 }}
					inert={!drawn}
					aria-hidden={drawn ? undefined : true}
				/>
			)}
			{drawn && pending.length > 0 && (
				<div className="mt-2">
					<AttachmentChip
						icon={Image}
						title="Diagram images"
						detail={`Not loaded · ${named}`}
						wrapDetail
						action={{
							label: "Load",
							ariaLabel: `Load diagram images from ${named}`,
							onClick: () => {
								setLoadPresses((presses) => presses + 1);
								for (const host of pending) allowHost(host);
							},
						}}
					/>
				</div>
			)}
		</figure>
	);
}
