import {
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type DroppedFiles,
	type FileDragZone,
	useFileDragZone,
} from "../../hooks/useFileDragZone";
import { parentDir } from "../../utils/path";

/** How long a folder must be hovered before it opens under the cursor. */
const SPRING_LOAD_MS = 700;
/** Distance from the top or bottom of the scroller that starts scrolling it. */
const EDGE_ZONE_PX = 40;
const EDGE_SCROLL_PX_PER_FRAME = 8;

interface AimedDrop extends DroppedFiles {
	/** Directory the drop landed in; empty is the workspace root. */
	destPath: string;
}

interface Options {
	/**
	 * Whether a drop can be aimed at all. When false the drag is still tracked,
	 * so the caller can say why it is being turned away, but nothing is resolved
	 * and nothing is handed over.
	 */
	enabled: boolean;
	onDrop: (dropped: AimedDrop) => void;
	/** The element the tree scrolls inside, for the edge auto-scroll. */
	getScrollContainer: () => HTMLElement | null;
}

export interface FileDrop {
	/** Whether a file drag is over the panel, refused drags included. */
	isDragging: boolean;
	/** Where a drop would land right now; null with no drag, or a refused one. */
	destPath: string | null;
	/** Folder the hover timer has asked the tree to open. */
	springOpenPath: string | null;
	dropProps: FileDragZone["dropProps"];
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
 * Desktop drag and drop for the Files tab: aiming, and the state that shows it.
 * What any drop zone needs — telling a file drag apart, the depth count, folders
 * — is `useFileDragZone`'s; this adds what aiming at a tree needs on top.
 */
export function useFileDrop({
	enabled,
	onDrop,
	getScrollContainer,
}: Options): FileDrop {
	const [destPath, setDestPath] = useState<string | null>(null);
	const [springOpenPath, setSpringOpenPath] = useState<string | null>(null);

	const springTimerRef = useRef<number | null>(null);
	const scrollFrameRef = useRef<number | null>(null);
	const scrollDirRef = useRef(0);

	// Held in refs so the callbacks below never have to be rebuilt. Only ever
	// read from an event, which is long after the effect that refreshed them.
	const onDropRef = useRef(onDrop);
	const getScrollContainerRef = useRef(getScrollContainer);
	useEffect(() => {
		onDropRef.current = onDrop;
		getScrollContainerRef.current = getScrollContainer;
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
		const container = getScrollContainerRef.current();
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
			const container = getScrollContainerRef.current();
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

	const zone = useFileDragZone({
		enabled,
		onDrop: useCallback(
			(dropped: DroppedFiles, target: EventTarget) =>
				onDropRef.current({ ...dropped, destPath: resolveDropTarget(target) }),
			[],
		),
		// Re-read on every move: the cursor crosses rows without ever leaving the
		// panel. Setting the same path again is a no-op, so this does not
		// re-render the tree on every pixel.
		onDragMove: useCallback(
			(event: ReactDragEvent<HTMLElement>) => {
				setDestPath(resolveDropTarget(event.target));
				if (event.type === "dragover") updateEdgeScroll(event.clientY);
			},
			[updateEdgeScroll],
		),
		onReset: useCallback(() => {
			setDestPath(null);
			setSpringOpenPath(null);
			clearSpring();
			stopEdgeScroll();
		}, [clearSpring, stopEdgeScroll]),
	});
	const { isDragging } = zone;

	// Holding over a folder opens it. Without this a collapsed folder could never
	// receive a drop, since a drag has no way to click. It never closes again: a
	// folder snapping shut under the cursor would move every row below it.
	useEffect(() => {
		if (!isDragging || !destPath) return;
		springTimerRef.current = window.setTimeout(() => {
			springTimerRef.current = null;
			setSpringOpenPath(destPath);
		}, SPRING_LOAD_MS);
		return clearSpring;
	}, [isDragging, destPath, clearSpring]);

	return {
		isDragging,
		destPath,
		springOpenPath,
		dropProps: zone.dropProps,
	};
}
