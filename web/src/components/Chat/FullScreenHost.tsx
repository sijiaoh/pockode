import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	FULL_SCREEN_OPENER_ATTR,
	type FullScreenSource,
} from "../../lib/fullScreen";
import { FullScreenViewer } from "./FullScreenViewer";

/**
 * Every block's current full screen source, by key. A block publishes while it
 * is mounted; the viewer reads whatever is published under the key it was
 * opened with, so a block that is replaced by another under the same key —
 * *Output so far* by *Output* — hands the open viewer over rather than closing
 * it.
 */
class SourceRegistry {
	private sources = new Map<string, FullScreenSource>();
	private listeners = new Set<() => void>();

	get = (key: string) => this.sources.get(key);

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	publish(key: string, source: FullScreenSource) {
		if (this.sources.get(key) === source) return;
		this.sources.set(key, source);
		this.emit();
	}

	/** Only the publisher's own source: a successor may already hold the key. */
	withdraw(key: string, source: FullScreenSource) {
		if (this.sources.get(key) !== source) return;
		this.sources.delete(key);
		this.emit();
	}

	private emit() {
		for (const listener of this.listeners) listener();
	}
}

interface FullScreenHostValue {
	registry: SourceRegistry;
	open: (key: string) => void;
}

const FullScreenHostContext = createContext<FullScreenHostValue | null>(null);

/**
 * Publishes `source` under `key` while the caller is mounted, and returns what
 * opens it — or null where there is nothing to open it in: outside a
 * transcript, or with no source.
 */
export function useFullScreen(
	key: string,
	source: FullScreenSource | undefined,
): (() => void) | null {
	const host = useContext(FullScreenHostContext);
	const registry = host?.registry;

	useLayoutEffect(() => {
		if (!registry || !source) return;
		registry.publish(key, source);
		return () => registry.withdraw(key, source);
	}, [registry, key, source]);

	const open = host?.open;
	return useMemo(
		() => (open && source ? () => open(key) : null),
		[open, source, key],
	);
}

/**
 * The one full screen viewer of a transcript.
 *
 * Here rather than in the block that opens it, because blocks come and go
 * while they are read: *Output so far* unmounts the moment the result
 * arrives, a permission card the moment it is answered. Rendered inside the
 * transcript's `CoveredSurface`, so the viewer's `Sheet` closes when an
 * overlay takes the chat.
 */
export function FullScreenHost({ children }: { children: ReactNode }) {
	const [registry] = useState(() => new SourceRegistry());
	const [openKey, setOpenKey] = useState<string | null>(null);
	const lastSourceRef = useRef<FullScreenSource | undefined>(undefined);
	/** Run once the viewer's history entry is gone; see `useBackToClose`. */
	const afterCloseRef = useRef<(() => void) | null>(null);

	const open = useCallback((key: string) => setOpenKey(key), []);
	const close = useCallback(() => setOpenKey(null), []);
	const closeThen = useCallback((after: () => void) => {
		afterCloseRef.current = after;
		setOpenKey(null);
	}, []);

	const source = useSyncExternalStore(registry.subscribe, () =>
		openKey === null ? undefined : registry.get(openKey),
	);
	// Kept across the frame a key can go unpublished, and no longer: a closed
	// viewer's source may be a whole log.
	if (openKey === null) lastSourceRef.current = undefined;
	else if (source) lastSourceRef.current = source;

	// A key left unpublished closes the viewer — but only if it still is a frame
	// later: publishers legitimately unmount and remount across commits, the
	// live output becoming the result, a thought moving from the turn's tail
	// into its row.
	useEffect(() => {
		if (openKey === null) return;
		let frame = 0;
		const check = () => {
			cancelAnimationFrame(frame);
			if (registry.get(openKey)) return;
			frame = requestAnimationFrame(() => {
				if (!registry.get(openKey)) setOpenKey(null);
			});
		};
		check();
		const unsubscribe = registry.subscribe(check);
		return () => {
			unsubscribe();
			cancelAnimationFrame(frame);
		};
	}, [registry, openKey]);

	// The sheet hands focus back to its opener, which may be gone: *Output so
	// far* became *Output* while it was open. The block now holding the key
	// takes it instead, so focus never falls to the page.
	const closedKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (openKey !== null) {
			closedKeyRef.current = openKey;
			return;
		}
		const key = closedKeyRef.current;
		closedKeyRef.current = null;
		if (key === null) return;
		const frame = requestAnimationFrame(() => {
			const active = document.activeElement;
			if (active && active !== document.body) return;
			document
				.querySelector<HTMLElement>(
					`[${FULL_SCREEN_OPENER_ATTR}="${CSS.escape(key)}"]`,
				)
				?.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [openKey]);

	const value = useMemo(() => ({ registry, open }), [registry, open]);
	const shown = source ?? lastSourceRef.current;

	return (
		<FullScreenHostContext value={value}>
			{children}
			{openKey !== null && shown && (
				<FullScreenViewer
					key={openKey}
					source={shown}
					onClose={close}
					closeThen={closeThen}
					afterCloseRef={afterCloseRef}
				/>
			)}
		</FullScreenHostContext>
	);
}
