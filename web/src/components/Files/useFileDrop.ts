import {
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { parentDir } from "../../utils/path";

/** How long a folder must be hovered before it opens under the cursor. */
const SPRING_LOAD_MS = 700;
/** Distance from the top or bottom of the scroller that starts scrolling it. */
const EDGE_ZONE_PX = 40;
const EDGE_SCROLL_PX_PER_FRAME = 8;

/** v1 uploads files, so a folder has to be refused rather than flattened. */
export const FOLDER_DROP_REFUSED =
	"Folders can't be uploaded. Drop individual files instead.";

interface DroppedFiles {
	files: File[];
	/** Whether the drag also held a folder, which is refused rather than sent. */
	hadFolder: boolean;
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
	onDrop: (dropped: DroppedFiles) => void;
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
	dropProps: {
		onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
		onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
		onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
		onDrop: (event: ReactDragEvent<HTMLElement>) => void;
	};
}

function carriesFiles(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	// What a drag carries is only readable as `types` until it is dropped;
	// `items` has no contents during `dragover`.
	return Array.from(dataTransfer.types).includes("Files");
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
 * Splits what was dropped into files to send and folders to refuse.
 *
 * A dropped folder also turns up in `files`, as a zero-byte entry that would be
 * uploaded as an empty file of that name. `webkitGetAsEntry` is the only thing
 * that tells the two apart, and it has to be called while the drop event is
 * still being handled.
 */
function readDropped(dataTransfer: DataTransfer): {
	files: File[];
	hadFolder: boolean;
} {
	const files: File[] = [];
	let hadFolder = false;
	let sawItem = false;

	for (const item of Array.from(dataTransfer.items)) {
		if (item.kind !== "file") continue;
		sawItem = true;
		const entry =
			typeof item.webkitGetAsEntry === "function"
				? item.webkitGetAsEntry()
				: null;
		if (entry?.isDirectory) {
			hadFolder = true;
			continue;
		}
		const file = item.getAsFile();
		if (file) files.push(file);
	}

	// Without `items` a folder cannot be recognised, so the plain list is all
	// there is; the server refuses a zero-byte name that is a directory anyway.
	if (!sawItem) return { files: Array.from(dataTransfer.files), hadFolder };
	return { files, hadFolder };
}

/**
 * Desktop drag and drop for the Files tab: aiming, and the state that shows it.
 *
 * The drag state stays here rather than in the upload queue — it is over in a
 * second and nothing outside this subtree has a use for it.
 */
export function useFileDrop({
	enabled,
	onDrop,
	getScrollContainer,
}: Options): FileDrop {
	const [isDragging, setIsDragging] = useState(false);
	const [destPath, setDestPath] = useState<string | null>(null);
	const [springOpenPath, setSpringOpenPath] = useState<string | null>(null);

	// Every child bubbles a `dragenter`/`dragleave` pair of its own as the cursor
	// crosses it, so only a depth count can tell leaving the panel apart from
	// moving around inside it; switching on the events themselves would flicker.
	const depthRef = useRef(0);
	const springTimerRef = useRef<number | null>(null);
	const scrollFrameRef = useRef<number | null>(null);
	const scrollDirRef = useRef(0);

	// Held in refs so the handlers below never have to be rebuilt, which keeps the
	// window listeners subscribed once for the life of the tab. Only ever read
	// from an event, which is long after the effect that refreshed them.
	const onDropRef = useRef(onDrop);
	const getScrollContainerRef = useRef(getScrollContainer);
	const enabledRef = useRef(enabled);
	useEffect(() => {
		onDropRef.current = onDrop;
		getScrollContainerRef.current = getScrollContainer;
		enabledRef.current = enabled;
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

	const reset = useCallback(() => {
		depthRef.current = 0;
		setIsDragging(false);
		setDestPath(null);
		setSpringOpenPath(null);
		clearSpring();
		stopEdgeScroll();
	}, [clearSpring, stopEdgeScroll]);

	// A drag that ends outside the window — dropped on the desktop, on devtools,
	// or cancelled with Escape — never delivers its last `dragleave`, so the
	// counter alone would leave the panel lit up until the next drag.
	useEffect(() => {
		window.addEventListener("drop", reset);
		window.addEventListener("dragend", reset);
		return () => {
			window.removeEventListener("drop", reset);
			window.removeEventListener("dragend", reset);
		};
	}, [reset]);

	useEffect(
		() => () => {
			clearSpring();
			stopEdgeScroll();
		},
		[clearSpring, stopEdgeScroll],
	);

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

	const handleDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
		if (!carriesFiles(event.dataTransfer)) return;
		event.preventDefault();
		depthRef.current += 1;
		setIsDragging(true);
		if (enabledRef.current) setDestPath(resolveDropTarget(event.target));
	}, []);

	const handleDragOver = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (!carriesFiles(event.dataTransfer)) return;
			// Required for the drop to happen at all: left alone, the browser's
			// default action for a file drag is to open the file.
			event.preventDefault();
			event.dataTransfer.dropEffect = enabledRef.current ? "copy" : "none";
			// Also here and not only on enter, so that a drag whose `dragenter` went
			// missing still gets told why it is being refused.
			setIsDragging(true);
			if (!enabledRef.current) return;
			// Re-read on every move: the cursor crosses rows without ever leaving the
			// panel. Setting the same path again is a no-op, so this does not
			// re-render the tree on every pixel.
			setDestPath(resolveDropTarget(event.target));
			updateEdgeScroll(event.clientY);
		},
		[updateEdgeScroll],
	);

	const handleDragLeave = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (!carriesFiles(event.dataTransfer)) return;
			depthRef.current = Math.max(0, depthRef.current - 1);
			if (depthRef.current === 0) reset();
		},
		[reset],
	);

	const handleDrop = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (!carriesFiles(event.dataTransfer)) return;
			event.preventDefault();
			const accepted = enabledRef.current;
			// Read before resetting: the event's data is only alive during dispatch.
			const dropped = accepted
				? {
						...readDropped(event.dataTransfer),
						destPath: resolveDropTarget(event.target),
					}
				: null;
			reset();
			if (dropped) onDropRef.current(dropped);
		},
		[reset],
	);

	return {
		isDragging,
		destPath,
		springOpenPath,
		dropProps: {
			onDragEnter: handleDragEnter,
			onDragOver: handleDragOver,
			onDragLeave: handleDragLeave,
			onDrop: handleDrop,
		},
	};
}
