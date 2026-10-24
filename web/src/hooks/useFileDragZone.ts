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

export interface DroppedFiles {
	files: File[];
	/**
	 * Folders the drag held, still to be read. They are entries rather than
	 * files: a folder's contents can only be walked through the entry, which
	 * stays valid after the event that handed it over.
	 */
	folders: FileSystemDirectoryEntry[];
}

export function carriesFiles(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	// What a drag carries is only readable as `types` until it is dropped;
	// `items` has no contents during `dragover`.
	return Array.from(dataTransfer.types).includes("Files");
}

/**
 * Splits what was dropped into files and folders.
 *
 * A dropped folder also turns up in `files`, as a zero-byte entry that would be
 * uploaded as an empty file of that name. `webkitGetAsEntry` is the only thing
 * that tells the two apart, and it has to be called while the drop (or paste)
 * event is still being handled.
 */
export function readDropped(dataTransfer: DataTransfer): DroppedFiles {
	const files: File[] = [];
	const folders: FileSystemDirectoryEntry[] = [];
	let sawItem = false;

	for (const item of Array.from(dataTransfer.items)) {
		if (item.kind !== "file") continue;
		sawItem = true;
		const entry =
			typeof item.webkitGetAsEntry === "function"
				? item.webkitGetAsEntry()
				: null;
		if (entry?.isDirectory) {
			folders.push(entry as FileSystemDirectoryEntry);
			continue;
		}
		const file = item.getAsFile();
		if (file) files.push(file);
	}

	// Without `items` a folder cannot be recognised, so the plain list is all
	// there is; the server refuses a zero-byte name that is a directory anyway.
	if (!sawItem) return { files: Array.from(dataTransfer.files), folders };
	return { files, folders };
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
 * recognises, so a pasted folder is one only where they do.
 */
export function readPasted(clipboardData: DataTransfer): DroppedFiles | null {
	const text = clipboardData.getData("text/plain");
	if (text !== "" && !namesCarriedFiles(text, clipboardData)) return null;
	const pasted = readDropped(clipboardData);
	if (pasted.files.length === 0 && pasted.folders.length === 0) return null;
	return pasted;
}

export type ZoneDropEffect = "copy" | "move" | "none";

interface DragZoneOptions<T> {
	/** Which drags the zone tracks at all; every other drag passes through it. */
	accepts: (dataTransfer: DataTransfer) => boolean;
	/**
	 * What letting go here would do, asked on every `dragover` and again at the
	 * drop: "none" turns the drag away at that spot. Asked per event rather than
	 * once per drag, since some drags are taken over one row and not the next.
	 */
	dropEffect: (event: ReactDragEvent<HTMLElement>) => ZoneDropEffect;
	/** What a taken drop hands over, read while its event is still alive. */
	read: (dataTransfer: DataTransfer) => T;
	onDrop: (dropped: T, target: EventTarget) => void;
	/**
	 * Every `dragenter`/`dragover` of a tracked drag, turned away or not; on a
	 * `dragover`, before `dropEffect` is asked about it.
	 */
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

export interface DragZone {
	/** Whether a tracked drag is over the zone, turned-away drags included. */
	isDragging: boolean;
	dropProps: {
		onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
		onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
		onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
		onDrop: (event: ReactDragEvent<HTMLElement>) => void;
	};
}

/**
 * An element that takes drags of some kind, or says it will not — what every
 * drop zone needs whatever it is that is dragged: the depth count, the resets
 * for a drag that ends elsewhere, and claiming the drag.
 *
 * Claims the drag in the bubbling phase, after `useFileDropGuard` has refused
 * it in the capture phase, so the zone's `dropEffect` is the one the cursor
 * shows. The drag state stays here rather than in any store — it is over in a
 * second and nothing outside the zone has a use for it.
 */
export function useDragZone<T>({
	accepts,
	dropEffect,
	read,
	onDrop,
	onDragMove,
	onReset,
	ownDomOnly = false,
}: DragZoneOptions<T>): DragZone {
	const [isDragging, setIsDragging] = useState(false);

	// Every child bubbles a `dragenter`/`dragleave` pair of its own as the cursor
	// crosses it, so only a depth count can tell leaving the zone apart from
	// moving around inside it; switching on the events themselves would flicker.
	const depthRef = useRef(0);
	const lostTimerRef = useRef<number | null>(null);

	// Held in refs so the handlers below never have to be rebuilt, which keeps the
	// window listeners subscribed once for the life of the zone. Only ever read
	// from an event, which is long after the effect that refreshed them.
	const optionsRef = useRef({
		accepts,
		dropEffect,
		read,
		onDrop,
		onDragMove,
		onReset,
	});
	useEffect(() => {
		optionsRef.current = {
			accepts,
			dropEffect,
			read,
			onDrop,
			onDragMove,
			onReset,
		};
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
			!!event.dataTransfer &&
			optionsRef.current.accepts(event.dataTransfer) &&
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
			optionsRef.current.onDragMove?.(event);
		},
		[isOurs, clearLostTimer],
	);

	const handleDragOver = useCallback(
		(event: ReactDragEvent<HTMLElement>) => {
			if (!isOurs(event)) return;
			// Required for the drop to happen at all: left alone, the browser's
			// default action for a file drag is to open the file, and for any other
			// drag is to refuse it.
			event.preventDefault();
			clearLostTimer();
			const { dropEffect, onDragMove } = optionsRef.current;
			// Also here and not only on enter, so that a drag whose `dragenter` went
			// missing still gets told why it is being refused.
			setIsDragging(true);
			onDragMove?.(event);
			event.dataTransfer.dropEffect = dropEffect(event);
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
			// Asked again rather than trusted from the last `dragover`: the drop is
			// where something is actually done, and the answer may have changed.
			// Read before resetting: the event's data is only alive during dispatch.
			const { dropEffect, read } = optionsRef.current;
			const taken = dropEffect(event) !== "none";
			const dropped = taken ? read(event.dataTransfer) : null;
			reset();
			if (taken) optionsRef.current.onDrop(dropped as T, event.target);
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
	/** See `useDragZone`. */
	ownDomOnly?: boolean;
}

export type FileDragZone = DragZone;

/** An element that takes files dragged onto it, or says it will not. */
export function useFileDragZone({
	enabled,
	onDrop,
	onDragMove,
	onReset,
	ownDomOnly,
}: Options): FileDragZone {
	return useDragZone({
		accepts: carriesFiles,
		dropEffect: () => (enabled ? "copy" : "none"),
		read: readDropped,
		onDrop,
		onDragMove: (event) => {
			if (enabled) onDragMove?.(event);
		},
		onReset,
		ownDomOnly,
	});
}
