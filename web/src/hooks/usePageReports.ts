import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	activatedIn,
	addRefusal,
	isEmbedDirective,
	linkUrl,
	NO_REFUSALS,
	type Refusals,
	readPageReport,
	readWrapperReport,
	refusedHost,
} from "../lib/pageHosts";

interface Options {
	/** The hosts the policy of the document now in the frame names. */
	hosts: readonly string[];
	/** The hosts the reader has allowed for the page, now. */
	allowed: ReadonlySet<string>;
	/** A message from the page that is no report, such as its height. */
	onPageMessage?: (data: unknown) => void;
	/** The wrapper's page has loaded. */
	onLoaded?: () => void;
}

/**
 * What the page in `frameRef` — a wrapper, with the page as its one frame —
 * reports (docs/page-external-hosts-ui.md): the hosts it was refused, the
 * latest link it asked to open that the app did not open itself, and whether
 * it left. Taken only from that page's window — every frame posts to the same
 * one, and a frame the page makes inside itself is not the page — and, for
 * leaving and loading, from the wrapper's, which the page cannot post as.
 *
 * Nothing here is more than something to show: the page shares its document
 * with the reporter and can say all of it itself.
 */
export function usePageReports(
	frameRef: RefObject<HTMLIFrameElement | null>,
	options: Options,
) {
	const [refusals, setRefusals] = useState<Refusals>(NO_REFUSALS);
	const [link, setLink] = useState<{ url: string; host: string } | null>(null);
	const [left, setLeft] = useState<{ host: string | null } | null>(null);
	// Read by the message handler, which outlives the render it was made in.
	const optionsRef = useRef(options);
	optionsRef.current = options;

	useEffect(() => {
		const ownHostname = window.location.hostname;
		const onMessage = (event: MessageEvent) => {
			const wrapper = frameRef.current?.contentWindow;
			if (!wrapper) return;
			const { hosts, allowed, onPageMessage, onLoaded } = optionsRef.current;
			if (event.source === wrapper) {
				const report = readWrapperReport(event.data);
				if (report?.type === "left") {
					setLeft({ host: refusedHost(report.url, ownHostname)?.host ?? null });
				} else if (report?.type === "loaded") {
					onLoaded?.();
				}
				return;
			}
			// `length` first: a cross-origin window throws on an index it has
			// no frame at, as a wrapper does until its page's frame is parsed.
			if (
				event.source === null ||
				wrapper.length === 0 ||
				event.source !== wrapper[0]
			) {
				return;
			}
			const report = readPageReport(event.data);
			if (report === null) {
				onPageMessage?.(event.data);
			} else if (report.type === "refused") {
				const refused = refusedHost(report.url, ownHostname);
				if (!refused) return;
				// A document the page embeds is never allowed, from any host:
				// it would run under no policy of ours.
				if (isEmbedDirective(report.directive)) {
					refused.allowable = false;
					refused.embedded = true;
				}
				// Offering a host the policy already names would only reload
				// into the same refusal.
				if (hosts.includes(refused.host)) {
					refused.allowable = false;
					refused.inPolicy = true;
				}
				setRefusals((current) => addRefusal(current, refused, allowed));
			} else {
				const url = linkUrl(report.href);
				if (!url) return;
				// The report alone opens nothing: the page could send it.
				if (activatedIn(frameRef.current)) {
					window.open(url.href, "_blank", "noopener,noreferrer");
				} else {
					setLink({ url: url.href, host: url.host });
				}
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [frameRef]);

	/** For a new document in the frame: what the last one said is not its. */
	const clear = useCallback(() => {
		setRefusals(NO_REFUSALS);
		setLink(null);
		setLeft(null);
	}, []);

	const openLink = () => {
		if (link) window.open(link.url, "_blank", "noopener,noreferrer");
		setLink(null);
	};

	return { refusals, link, left, clear, openLink };
}
