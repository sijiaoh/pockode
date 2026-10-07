import {
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

/**
 * How long a drag that left for nowhere may go without a `dragover` before it
 * is taken to have left the window. Browsers repeat `dragover` while a drag
 * rests over an element — the HTML spec says every 350ms ± 200ms, Chromium far
 * more often — so a drag still in the zone always answers well inside this.
 */
const LOST_DRAG_MS = 1000;

/** v1 uploads files, so a folder has to be refused rather than flattened. */
export const FOLDER_DROP_REFUSED =
	"Folders can't be uploaded. Drop individual files instead.";

export interface DroppedFiles {
	files: File[];
	/** Whether the drag also held a folder, which is refused rather than sent. */
	hadFolder: boolean;
}

export function carriesFiles(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	// What a drag carries is only readable as `types` until it is dropped;
	// `items` has no contents during `dragover`.
	return Array.from(dataTransfer.types).includes("Files");
}

/**
 * Splits what was dropped into files to send and folders to refuse.
 *
 * A dropped folder also turns up in `files`, as a zero-byte entry that would be
 * uploaded as an empty file of that name. `webkitGetAsEntry` is the only thing
 * that tells the two apart, and it has to be called while the drop (or paste)
 * event is still being handled.
 */
export function readDropped(dataTransfer: DataTransfer): DroppedFiles {
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
 * The name a file manager's text gives for a file it put on the clipboard, or
 * null when the line is not a reference to a local file: a bare name (Finder),
 * an absolute path (GNOME Files, Dolphin) or a `file:` URI. A web address or
 * a relative path ending in the same name is not the file, so it is not one.
 */
function referencedName(line: string): string | null {
	let path = line;
	if (/^file:/i.test(line)) {
		try {
			path = decodeURIComponent(new URL(line).pathname);
		} catch {
			return null;
		}
	} else if (/[\\/]/.test(line) && !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(line)) {
		return null;
	}
	// A folder may be named with a trailing separator.
	return (
		path
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() || null
	);
}

/** Whether the text is nothing but the names of files the clipboard carries. */
function namesCarriedFiles(text: string, clipboardData: DataTransfer): boolean {
	const lines = text
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length === 0) return false;

	// Folders included, which `readDropped` leaves out of its files.
	const carried = new Set(Array.from(clipboardData.files, (file) => file.name));
	for (const item of Array.from(clipboardData.items)) {
		const file = item.kind === "file" ? item.getAsFile() : null;
		if (file) carried.add(file.name);
	}
	return lines.every((line) => {
		const name = referencedName(line);
		return name !== null && carried.has(name);
	});
}

/**
 * The files a paste carries, or null when the paste is text and belongs to the
 * browser. Text wins whenever there is any: copying from a spreadsheet or a web
 * page brings a rendered picture along with the text, and nobody pasting a
 * table wants the picture of it.
 *
 * The exception is text that only names the files themselves. Copying a file
 * in a file manager puts its name or path beside it as text — Finder its name,
 * GNOME Files and Dolphin its path or URI, one per line — and what was copied
 * there is the file. Explorer puts no text, so it needs no exception. Matching
 * the names, rather than the shape of the text, keeps a browser that hands
 * over only Finder's icon for the file pasting the name: the icon is not it.
 *
 * Browsers rarely put a folder on the clipboard as anything `webkitGetAsEntry`
 * recognises, so a pasted folder is refused only where they do.
 */
export function readPasted(clipboardData: DataTransfer): DroppedFiles | null {
	const text = clipboardData.getData("text/plain");
	if (text !== "" && !namesCarriedFiles(text, clipboardData)) return null;
	const pasted = readDropped(clipboardData);
	if (pasted.files.length === 0 && !pasted.hadFolder) return null;
	return pasted;
}

interface Options {
	/**
	 * Whether a drop is taken. When false the drag is still tracked, so the
	 * caller can say why it is being turned away, but nothing is handed over.
	 */
	enabled: boolean;
	onDrop: (dropped: DroppedFiles, target: EventTarget) => void;
	/** Every `dragenter`/`dragover` of a drag that would be taken. */
	onDragMove?: (event: ReactDragEvent<HTMLElement>) => void;
	/** The drag is over: left, dropped, or ended somewhere else. */
	onReset?: () => void;
	/**
	 * Only take drags whose DOM target is inside the zone's element. A portal's
	 * events travel the React tree, so without this a drag over a sheet raised
	 * from inside the zone is the zone's too — and lands behind the sheet.
	 */
	ownDomOnly?: boolean;
}

export interface FileDragZone {
	/** Whether a file drag is over the zone, refused drags included. */
	isDragging: boolean;
	dropProps: {
		onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
		onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
		onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
		onDrop: (event: ReactDragEvent<HTMLElement>) => void;
	};
}

/**
 * An element that takes files dragged onto it, or says it will not.
 *
 * Claims the drag in the bubbling phase, after `useFileDropGuard` has refused
 * it in the capture phase, so the zone's `dropEffect` is the one the cursor
 * shows. The drag state stays here rather than in any store — it is over in a
 * second and nothing outside the zone has a use for it.
 */
export function useFileDragZone({
	enabled,
	onDrop,
	onDragMove,
	onReset,
	ownDomOnly = false,
}: Options): FileDragZone {
	const [isDragging, setIsDragging] = useState(false);

	// Every child bubbles a `dragenter`/`dragleave` pair of its own as the cursor
	// crosses it, so only a depth count can tell leaving the zone apart from
	// moving around inside it; switching on the events themselves would flicker.
	const depthRef = useRef(0);
	const lostTimerRef = useRef<number | null>(null);

	// Held in refs so the handlers below never have to be rebuilt, which keeps the
	// window listeners subscribed once for the life of the zone. Only ever read
	// from an event, which is long after the effect that refreshed them.
	const optionsRef = useRef({ enabled, onDrop, onDragMove, onReset });
	useEffect(() => {
		optionsRef.current = { enabled, onDrop, onDragMove, onReset };
	});

	const clearLostTimer = useCallback(() => {
		if (lostTimerRef.current === null) return;
		clearTimeout(lostTimerRef.current);
		lostTimerRef.current = null;
	}, []);

	const reset = useCallback(() => {
		clearLostTimer();
		depthRef.current = 0;
		setIsDragging(false);
		optionsRef.current.onReset?.();
	}, [clearLostTimer]);

	useEffect(() => clearLostTimer, [clearLostTimer]);

	// A drag that ends outside the window — dropped on the desktop, on devtools,
	// or cancelled with Escape — never delivers its last `dragleave`, so the
	// counter alone would leave the zone lit up until the next drag.
	useEffect(() => {
		window.addEventListener("drop", reset);
		window.addEventListener("dragend", reset);
		return () => {
			window.removeEventListener("drop", reset);
			window.removeEventListener("dragend", reset);
		};
	}, [reset]);

	// Ignored events are not counted either: a drag moving onto a sheet delivers
	// its `dragenter` there, which must not hold the zone open behind it.
	const isOurs = useCallback(
		(event: ReactDragEvent<HTMLElement>) =>
			carriesFiles(event.dataTransfer) &&
			(!ownDomOnly || event.currentTarget.contains(event.target as Node)),
		[ownDomOnly],
	);

	const handleDragEnter = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (!isOurs(event)) return;
			event.preventDefault();
			clearLostTimer();
			depthRef.current += 1;
			setIsDragging(true);
			if (optionsRef.current.enabled) optionsRef.current.onDragMove?.(event);
		},
		[isOurs, clearLostTimer],
	);

	const handleDragOver = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (!isOurs(event)) return;
			// Required for the drop to happen at all: left alone, the browser's
			// default action for a file drag is to open the file.
			event.preventDefault();
			clearLostTimer();
			const { enabled, onDragMove } = optionsRef.current;
			event.dataTransfer.dropEffect = enabled ? "copy" : "none";
			// Also here and not only on enter, so that a drag whose `dragenter` went
			// missing still gets told why it is being refused.
			setIsDragging(true);
			if (enabled) onDragMove?.(event);
		},
		[isOurs, clearLostTimer],
	);

	const handleDragLeave = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (!isOurs(event)) return;
			depthRef.current = Math.max(0, depthRef.current - 1);
			if (depthRef.current === 0) {
				reset();
				return;
			}
			// The count is one too high whenever an element left the page with the
			// cursor over it — its `dragleave` is never delivered — which a
			// streaming transcript does all the time. So a leave that says where it
			// went is believed over the count…
			const next = event.relatedTarget;
			if (next === null) {
				// …and one that went nowhere (out of the window, or a browser that
				// leaves `relatedTarget` unset) is believed once no `dragover` says
				// the drag is still here.
				clearLostTimer();
				lostTimerRef.current = window.setTimeout(reset, LOST_DRAG_MS);
				return;
			}
			// Only a zone that owns just its DOM can tell outside from the DOM: a
			// zone that also owns its portals has them outside its element.
			if (
				ownDomOnly &&
				!(next instanceof Node && event.currentTarget.contains(next))
			) {
				reset();
			}
		},
		[isOurs, reset, clearLostTimer, ownDomOnly],
	);

	const handleDrop = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (!isOurs(event)) return;
			event.preventDefault();
			// Read before resetting: the event's data is only alive during dispatch.
			const dropped = optionsRef.current.enabled
				? readDropped(event.dataTransfer)
				: null;
			reset();
			if (dropped) optionsRef.current.onDrop(dropped, event.target);
		},
		[isOurs, reset],
	);

	return {
		isDragging,
		dropProps: {
			onDragEnter: handleDragEnter,
			onDragOver: handleDragOver,
			onDragLeave: handleDragLeave,
			onDrop: handleDrop,
		},
	};
}
