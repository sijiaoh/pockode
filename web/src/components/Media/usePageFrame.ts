import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { usePageReports } from "../../hooks/usePageReports";
import { useRawMediaSource } from "../../hooks/useRawMediaSource";
import {
	allowedPageHosts,
	allowPageHosts,
	capabilityRoot,
	navigateWrapper,
	rawPageWrapper,
	useAllowedPageHosts,
} from "../../lib/pageHosts";
import {
	isDeadCapability,
	isGone,
	isOutsideScope,
	probeRaw,
} from "../../lib/rawProbe";
import { pageRawTarget, pageRawUrl, type RawTarget } from "../../lib/rpc/raw";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { TreeOrigin } from "../../types/contents";
import { asError } from "../../utils/errorMessage";
import { HTML_FRAME_SANDBOX } from "../Chat/HtmlFrame";
import type { MediaFailure } from "./useMediaPlayback";
import { RECOVERY_WINDOW_MS } from "./useMediaPlayback";

interface State {
	identity: string;
	/** What the frame loads; set once and then only by the app's own loads. */
	url: string | null;
	/** Bumped for every load the app starts. */
	generation: number;
	/** The load the app started has finished. */
	loaded: boolean;
	/** The worktree switch count the capability `url` is under was asked for in. */
	epoch: number;
	/** Asking for a capability for the next load. */
	busy: boolean;
	failure: MediaFailure | null;
}

function initialState(identity: string): State {
	return {
		identity,
		url: null,
		generation: 0,
		loaded: false,
		epoch: 0,
		busy: false,
		failure: null,
	};
}

function sorted(hosts: ReadonlySet<string>): readonly string[] {
	return [...hosts].sort();
}

/**
 * An HTML page in a sandboxed frame, loaded from a raw capability for the
 * directory it sits in so its relative assets load too (docs/file.md, "HTML
 * pages"). Spread `frameProps` on the `<iframe>`, and `strip` on a
 * `PageHostsStrip` above it.
 *
 * The page reaches no host the reader has not allowed for it
 * (docs/page-external-hosts-ui.md): the server binds the hosts to the
 * capability and refuses the page the rest, and the `<iframe>` is a wrapper,
 * one per capability, that holds the page to it (`rawPageWrapper`). The hosts
 * a frame is drawn under are the ones allowed when it was — a frame opened
 * after an allowance starts with it — and change only by a load the app
 * starts, never because the reader allowed them in another view.
 *
 * A page is never reloaded behind the user's back: the frame keeps the URL it
 * loaded with, and a capability renewed by anyone else waits for the next load
 * the app starts — `reload`, `retry`, a change of `revision`, or a remount.
 * Each such load under the same capability navigates the same frame, even to
 * the URL it already has: it is a navigation like one inside the page, so
 * Back steps back through it. Another capability — renewed, or with other
 * hosts — needs another wrapper, whose `frame-src` names it; the old one's
 * entries stay in the session history, where Chromium and WebKit keep a
 * removed frame's, and Back onto one of them does nothing.
 *
 * An iframe reports no errors, so after each load the app started its URL is
 * probed for one byte. A capability that has died is renewed once, silently;
 * dying again within `RECOVERY_WINDOW_MS`, or anything else wrong, is a
 * `failure`. Loads from navigation inside the page are the page's own.
 *
 * `revision` stands for the page's content: a change reloads the page from
 * the start, which is what an edit to it calls for.
 *
 * A directory capability that cannot reach the page — its directory is
 * behind a link, which a directory scope never follows, or unreadable — is
 * given up for one for the page alone, which can still show it
 * (`unreachableFolder`). A caller that already knows, as the viewer does from
 * its opener, passes it in and skips the try.
 */
export function usePageFrame(
	page: { origin: TreeOrigin; fileName: string; unreachableFolder?: boolean },
	enabled: boolean,
	revision?: unknown,
) {
	const { origin, fileName } = page;
	const worktree = useWorktreeStore((s) => s.current);
	// Per worktree: the same path in another one may well be a plain folder.
	const folderKey = `${worktree}:${JSON.stringify(origin)}`;
	// What the reader's allowance is for: this file, wherever it is shown, and
	// whatever the frame goes on to inside its directory.
	const pageKey = `file:${folderKey}`;
	const allowed = useAllowedPageHosts(pageKey);
	const [drawn, setDrawn] = useState(() => ({
		pageKey,
		hosts: sorted(allowed),
	}));
	let hosts = drawn.hosts;
	if (drawn.pageKey !== pageKey) {
		hosts = sorted(allowed);
		setDrawn({ pageKey, hosts });
	}
	const [unreachableFor, setUnreachableFor] = useState<string | null>(null);
	const unreachableFolder =
		page.unreachableFolder === true || unreachableFor === folderKey;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `folderKey` is the identity of `origin`, which callers rebuild every render
	const target = useMemo<RawTarget>(
		() => ({
			...(unreachableFolder
				? { origin, scope: "file" as const }
				: pageRawTarget(origin)),
			page: { hosts },
		}),
		[folderKey, unreachableFolder, hosts],
	);
	const source = useRawMediaSource(target, enabled);
	const { refresh, fresh } = source;
	const identity = `${source.key}:${fileName}`;

	const [stored, setState] = useState(() => initialState(identity));
	let state = stored;
	if (stored.identity !== identity) {
		state = initialState(identity);
		setState(state);
	}

	const toPage = useCallback(
		(capabilityUrl: string) => pageRawUrl(target, capabilityUrl, fileName),
		[target, fileName],
	);

	// The first capability is taken as it comes; later ones only after a
	// worktree switch, when the one the frame loaded may serve the worktree
	// that was left. One issued before the switch is waited out either way.
	const issuedForThisWorktree =
		source.src !== null && source.epoch === source.currentEpoch;
	const stale = state.url !== null && state.epoch !== source.currentEpoch;
	if (
		source.src !== null &&
		issuedForThisWorktree &&
		!state.busy &&
		!state.failure &&
		(state.url === null || stale)
	) {
		state = {
			...state,
			url: toPage(source.src),
			epoch: source.epoch,
			generation: state.url === null ? state.generation : state.generation + 1,
			loaded: false,
		};
		setState(state);
	}

	// Whether a failure card is up, whether held in state or derived from the
	// capability request below: either way the URL behind it is not one to
	// show again while a new one is asked for.
	const failing = useRef(false);
	const pending = useRef<AbortController | null>(null);
	const recovery = useRef<number | null>(null);
	// A renewal in flight: a load that cuts in on it renews too, or it would
	// be handed the dead capability the renewal was replacing.
	const renewing = useRef(false);
	// A load asked for and not yet answered. `busy` says the same, but only
	// from the next render: a frame's `load` landing before it must not be
	// taken for the new load's, nor abort it by probing.
	const asking = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `identity` is the trigger — what is in flight is for the page before it
	useEffect(() => {
		recovery.current = null;
		renewing.current = false;
		asking.current = false;
		return () => pending.current?.abort();
	}, [identity]);

	const update = useCallback(
		(change: (current: State) => Partial<State>) =>
			setState((current) =>
				current.identity === identity
					? { ...current, ...change(current) }
					: current,
			),
		[identity],
	);

	const start = useCallback(() => {
		pending.current?.abort();
		const controller = new AbortController();
		pending.current = controller;
		return controller.signal;
	}, []);

	/**
	 * Loads the page again from its entry URL, on a capability that will last
	 * (`renew` asks for a new one regardless). A page on screen stays until
	 * the new capability is there to load it from; a failure card gives way to
	 * the spinner, since the URL behind it is the one that failed.
	 */
	const load = useCallback(
		(renew: boolean) => {
			const renewal = renew || renewing.current;
			renewing.current = renewal;
			asking.current = true;
			const signal = start();
			const shownFailure = failing.current;
			update((current) => ({
				busy: true,
				failure: null,
				url: shownFailure || current.failure ? null : current.url,
			}));
			(renewal ? refresh : fresh)(signal).then(
				({ src, epoch }) => {
					if (signal.aborted) return;
					renewing.current = false;
					asking.current = false;
					update((current) => ({
						busy: false,
						url: toPage(src),
						epoch,
						generation: current.generation + 1,
						loaded: false,
					}));
				},
				(error: unknown) => {
					if (signal.aborted) return;
					renewing.current = false;
					asking.current = false;
					update(() => ({
						busy: false,
						failure: { kind: "load", error: asError(error) },
					}));
				},
			);
		},
		[fresh, refresh, start, toPage, update],
	);

	const onLoad = () => {
		const url = state.url;
		// While a new load is being asked for, the frame on screen is the one
		// it replaces.
		if (state.loaded || state.busy || asking.current || url === null) return;
		update(() => ({ loaded: true }));
		const signal = start();
		probeRaw(url, signal).then((answer) => {
			if (signal.aborted || answer.ok) return;
			// Another capability, so another frame: this one's history ends with
			// its first load, which adds no entry.
			if (target.scope === "directory" && isOutsideScope(answer)) {
				setUnreachableFor(folderKey);
				return;
			}
			const last = recovery.current;
			if (
				isDeadCapability(answer) &&
				(last === null || Date.now() - last > RECOVERY_WINDOW_MS)
			) {
				recovery.current = Date.now();
				load(true);
				return;
			}
			update(() => ({
				failure: isGone(answer)
					? { kind: "gone" }
					: { kind: "load", error: answer.error },
			}));
		});
	};

	// A load under the capability the wrapper already holds is a navigation
	// of its page, made here. A wrapper mounted by this very commit — the
	// first, one back after a failure card, or one for another capability —
	// is already loading its page: it was written with it.
	const frame = useRef<HTMLIFrameElement | null>(null);
	const generation = useRef(state.generation);
	generation.current = state.generation;
	const frameLoad = useRef(state.generation);
	// The page a Load was pressed for, whose next frame takes the focus, so a
	// keyboard or screen reader is not dropped to the top of the screen — and
	// only that page's: another file opened before the frame comes up keeps
	// its own place.
	const focusFor = useRef<string | null>(null);
	const shownPage = useRef(pageKey);
	shownPage.current = pageKey;
	const frameRef = useCallback((node: HTMLIFrameElement | null) => {
		frame.current = node;
		frameLoad.current = generation.current;
		if (node && focusFor.current !== null) {
			if (focusFor.current === shownPage.current) node.focus();
			focusFor.current = null;
		}
	}, []);
	useLayoutEffect(() => {
		const element = frame.current;
		if (
			!element ||
			state.url === null ||
			frameLoad.current === state.generation
		) {
			return;
		}
		frameLoad.current = state.generation;
		// To a wrapper mounted before this load: one mounted since is skipped
		// above, having been written with the page. One not yet listening is
		// still loading the page from this very URL.
		navigateWrapper(element, state.url);
	}, [state.generation, state.url]);

	const root = state.url === null ? null : capabilityRoot(state.url);
	const frameKey = `${identity}:${root}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: written once per wrapper, which `frameKey` names; a load under it navigates instead
	const srcDoc = useMemo(
		() =>
			state.url === null
				? null
				: rawPageWrapper(state.url, fileName, HTML_FRAME_SANDBOX),
		[frameKey],
	);

	const onLoadRef = useRef(onLoad);
	onLoadRef.current = onLoad;
	const reports = usePageReports(frame, {
		hosts,
		allowed,
		onLoaded: () => onLoadRef.current(),
	});
	// Each document the app loads is reported on afresh.
	const reported = `${frameKey}:${state.generation}`;
	const [reportedFor, setReportedFor] = useState(reported);
	if (reportedFor !== reported) {
		setReportedFor(reported);
		reports.clear();
	}

	/**
	 * Loads the page again from its entry URL. With hosts allowed since the
	 * frame was drawn, that is a new frame under them.
	 */
	const reload = () => {
		const now = sorted(allowedPageHosts(pageKey));
		if (now.join(" ") !== hosts.join(" ")) {
			setDrawn({ pageKey, hosts: now });
		} else {
			load(false);
		}
	};

	const loadRef = useRef(load);
	loadRef.current = load;
	const hasPage = useRef(false);
	hasPage.current = state.url !== null;
	const shown = useRef({ identity, revision });
	useEffect(() => {
		const before = shown.current;
		shown.current = { identity, revision };
		if (
			before.identity === identity &&
			before.revision !== revision &&
			hasPage.current
		) {
			loadRef.current(false);
		}
	}, [identity, revision]);

	// A capability that could not be had, for a frame that has none or holds
	// one that may serve another worktree.
	const failure: MediaFailure | null =
		state.failure ??
		((state.url === null || stale) && !state.busy && source.error
			? { kind: "load", error: source.error }
			: null);
	failing.current = failure !== null;

	return {
		/**
		 * A load the app started has not finished. A page waiting on a slow
		 * asset is shown regardless — it may well be readable already.
		 */
		loading: !failure && (state.busy || stale || !state.loaded),
		failure,
		/** Starts the page over from its entry URL, where the user navigated. */
		reload,
		/** After a failure: a new capability, in case the old one is the fault. */
		retry: () => {
			recovery.current = Date.now();
			load(true);
		},
		/** Loaded on its own after its directory's capability could not reach it. */
		unreachableFolder,
		/** The URL the page was loaded from, for saving it. */
		url: state.url,
		/**
		 * Key the `<iframe>` by it: another page, or another capability, is
		 * another frame.
		 */
		frameKey,
		/** Null until there is a capability to load the page from. */
		frameProps:
			srcDoc === null
				? null
				: { ref: frameRef, srcDoc, sandbox: HTML_FRAME_SANDBOX },
		/** For the `PageHostsStrip` above the frame, keyed by `stripKey`. */
		strip: {
			refusals: reports.refusals,
			allowed,
			link: reports.link,
			left: reports.left,
			onLoad: (more: string[]) => {
				allowPageHosts(pageKey, more);
				focusFor.current = pageKey;
				setDrawn({ pageKey, hosts: sorted(allowedPageHosts(pageKey)) });
			},
			onReload: reload,
			onOpenLink: reports.openLink,
		},
		/** Each document's strip is its own: reviewed, announced and held afresh. */
		stripKey: reported,
	} as const;
}
