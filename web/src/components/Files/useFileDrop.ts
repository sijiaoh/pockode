import {
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	carriesFiles,
	type DragZone,
	type DroppedFiles,
	readDropped,
	useDragZone,
} from "../../hooks/useFileDragZone";
import { carriesEntry } from "../../lib/entryDrag";
import { parentDir } from "../../utils/path";

/** How long a folder must be hovered before it opens under the cursor. */
const SPRING_LOAD_MS = 700;
/** Distance from the top or bottom of the scroller that starts scrolling it. */
const EDGE_ZONE_PX = 40;
const EDGE_SCROLL_PX_PER_FRAME = 8;

/**
 * What is being dragged: files from outside the browser, or an entry of this
 * tree. The two never mix — a row's drag carries no `Files`, and an outside
 * drag never carries the row type.
 */
export type DragKind = "files" | "entry";

type Dropped =
	| (DroppedFiles & { kind: "files" })
	/** The entry is the one the tree's own drag started from. */
	| { kind: "entry" };

type AimedDrop = Dropped & {
	/** Directory the drop landed in; empty is the workspace root. */
	destPath: string;
};

interface Options {
	/**
	 * Whether a drop of this kind is taken at `destPath` (empty is the root).
	 * Files are taken or not wherever they are aimed; an entry depends on where.
	 * A drag turned away is still tracked, so the caller can say why.
	 */
	accepts: (kind: DragKind, destPath: string) => boolean;
	/**
	 * Whether a drag carrying an entry is one this tree started. A row dragged
	 * from another window or tab carries the type too, and is nobody's here.
	 */
	ownsEntryDrag: () => boolean;
	onDrop: (dropped: AimedDrop) => void;
	/** The element the tree scrolls inside, for the edge auto-scroll. */
	getScrollContainer: () => HTMLElement | null;
}

export interface FileDrop {
	/** What is being dragged over the panel, turned-away drags included. */
	dragKind: DragKind | null;
	/**
	 * Where a drop would land right now; null with no drag, or with files that
	 * are turned away wherever they go. Set for an entry turned away here, since
	 * where it is aimed is what says why.
	 */
	destPath: string | null;
	/** Folder the hover timer has asked the tree to open. */
	springOpenPath: string | null;
	dropProps: DragZone["dropProps"];
}

function kindOf(dataTransfer: DataTransfer): DragKind {
	return carriesFiles(dataTransfer) ? "files" : "entry";
}

/**
 * The folder a drop on `target` belongs to.
 *
 * Every point in the panel has an answer and none is dead space: a folder row
 * takes the file, a file row hands it to the folder holding it, and anything
 * with no row above it — the search bar, the blank tree, the empty state — is
 * the project root.
 */
function resolveDropTarget(target: EventTarget | null): string {
	if (!(target instanceof Element)) return "";
	const row = target.closest<HTMLElement>("[data-entry-path]");
	if (!row) return "";
	const path = row.dataset.entryPath ?? "";
	return row.dataset.entryType === "dir" ? path : parentDir(path);
}

/**
 * Desktop drag and drop for the Files tab: aiming, and the state that shows it,
 * for files dropped in from outside and for entries moved within the tree
 * alike. What any drop zone needs — the depth count, the resets — is
 * `useDragZone`'s; this adds what aiming at a tree needs on top.
 */
export function useFileDrop({
	accepts,
	ownsEntryDrag,
	onDrop,
	getScrollContainer,
}: Options): FileDrop {
	const [dragKind, setDragKind] = useState<DragKind | null>(null);
	const [destPath, setDestPath] = useState<string | null>(null);
	const [springOpenPath, setSpringOpenPath] = useState<string | null>(null);

	const springTimerRef = useRef<number | null>(null);
	const scrollFrameRef = useRef<number | null>(null);
	const scrollDirRef = useRef(0);

	// Held in refs so the callbacks below never have to be rebuilt. Only ever
	// read from an event, which is long after the effect that refreshed them.
	const optionsRef = useRef({
		accepts,
		ownsEntryDrag,
		onDrop,
		getScrollContainer,
	});
	useEffect(() => {
		optionsRef.current = {
			accepts,
			ownsEntryDrag,
			onDrop,
			getScrollContainer,
		};
	});

	const clearSpring = useCallback(() => {
		if (springTimerRef.current === null) return;
		clearTimeout(springTimerRef.current);
		springTimerRef.current = null;
	}, []);

	const stopEdgeScroll = useCallback(() => {
		scrollDirRef.current = 0;
		if (scrollFrameRef.current === null) return;
		cancelAnimationFrame(scrollFrameRef.current);
		scrollFrameRef.current = null;
	}, []);

	useEffect(
		() => () => {
			clearSpring();
			stopEdgeScroll();
		},
		[clearSpring, stopEdgeScroll],
	);

	const scrollByOneFrame = useCallback(() => {
		scrollFrameRef.current = null;
		const container = optionsRef.current.getScrollContainer();
		if (!container || scrollDirRef.current === 0) return;
		container.scrollTop += scrollDirRef.current * EDGE_SCROLL_PX_PER_FRAME;
		scrollFrameRef.current = requestAnimationFrame(scrollByOneFrame);
	}, []);

	/**
	 * Scrolls the tree while the cursor rests near its top or bottom edge.
	 *
	 * The scroller is the element `PullToRefresh` renders, not the window: the
	 * panel itself never scrolls, so without this only the folders already on
	 * screen could be aimed at.
	 */
	const updateEdgeScroll = useCallback(
		(clientY: number) => {
			const container = optionsRef.current.getScrollContainer();
			if (!container || container.scrollHeight <= container.clientHeight) {
				stopEdgeScroll();
				return;
			}

			const rect = container.getBoundingClientRect();
			let direction = 0;
			if (clientY >= rect.top && clientY <= rect.bottom) {
				if (clientY < rect.top + EDGE_ZONE_PX) direction = -1;
				else if (clientY > rect.bottom - EDGE_ZONE_PX) direction = 1;
			}

			if (direction === 0) {
				stopEdgeScroll();
				return;
			}
			scrollDirRef.current = direction;
			// Restarted from the direction alone rather than only when it changes:
			// a loop that stopped for any other reason would otherwise never come
			// back while the cursor sat still at the same edge.
			if (scrollFrameRef.current === null) {
				scrollFrameRef.current = requestAnimationFrame(scrollByOneFrame);
			}
		},
		[scrollByOneFrame, stopEdgeScroll],
	);

	const zone = useDragZone<Dropped>({
		// Files first: a drag carrying both is not one this tree started.
		accepts: useCallback(
			(dataTransfer: DataTransfer) =>
				carriesFiles(dataTransfer) ||
				(carriesEntry(dataTransfer) && optionsRef.current.ownsEntryDrag()),
			[],
		),
		dropEffect: useCallback((event: ReactDragEvent<HTMLElement>) => {
			const kind = kindOf(event.dataTransfer);
			if (!optionsRef.current.accepts(kind, resolveDropTarget(event.target))) {
				return "none";
			}
			return kind === "files" ? "copy" : "move";
		}, []),
		read: useCallback(
			(dataTransfer: DataTransfer): Dropped =>
				kindOf(dataTransfer) === "files"
					? { kind: "files", ...readDropped(dataTransfer) }
					: { kind: "entry" },
			[],
		),
		onDrop: useCallback(
			(dropped: Dropped, target: EventTarget) =>
				optionsRef.current.onDrop({
					...dropped,
					destPath: resolveDropTarget(target),
				}),
			[],
		),
		// Re-read on every move: the cursor crosses rows without ever leaving the
		// panel. Setting the same value again is a no-op, so this does not
		// re-render the tree on every pixel.
		onDragMove: useCallback(
			(event: ReactDragEvent<HTMLElement>) => {
				const kind = kindOf(event.dataTransfer);
				const dest = resolveDropTarget(event.target);
				setDragKind(kind);
				// Files turned away are turned away everywhere, so there is nothing
				// to aim and nothing to scroll towards. An entry turned away here may
				// be taken a row further on, which the user has to be able to reach.
				if (kind === "files" && !optionsRef.current.accepts(kind, dest)) {
					return;
				}
				setDestPath(dest);
				if (event.type === "dragover") updateEdgeScroll(event.clientY);
			},
			[updateEdgeScroll],
		),
		onReset: useCallback(() => {
			setDragKind(null);
			setDestPath(null);
			setSpringOpenPath(null);
			clearSpring();
			stopEdgeScroll();
		}, [clearSpring, stopEdgeScroll]),
	});
	const { isDragging } = zone;
	// Asked on render as well as per event: whether the folder under the cursor
	// takes this drag decides whether hovering opens it.
	const aimAccepted =
		dragKind !== null && destPath !== null && accepts(dragKind, destPath);

	// Holding over a folder opens it. Without this a collapsed folder could never
	// receive a drop, since a drag has no way to click. It never closes again: a
	// folder snapping shut under the cursor would move every row below it.
	// Not over a folder that would turn the drop away, which for a moved folder
	// is itself and everything inside it: nothing there is a place to go.
	useEffect(() => {
		if (!isDragging || !destPath || !aimAccepted) return;
		springTimerRef.current = window.setTimeout(() => {
			springTimerRef.current = null;
			setSpringOpenPath(destPath);
		}, SPRING_LOAD_MS);
		return clearSpring;
	}, [isDragging, destPath, aimAccepted, clearSpring]);

	return {
		dragKind: isDragging ? dragKind : null,
		destPath,
		springOpenPath,
		dropProps: zone.dropProps,
	};
}
