import type { FolderContents } from "./fileUpload";

/**
 * Files one folder upload takes, read or picked.
 *
 * Far below the server's own cap (`MaxFolderEntries`, docs/file.md#uploading-a-folder),
 * which is only a backstop: a folder this large dropped by hand is nearly always
 * a `node_modules` or a `.git` along for the ride, and saying so before reading
 * all of it beats a refusal after the upload.
 */
export const MAX_FOLDER_FILES = 1000;

/** Why a folder cannot be sent; nothing of it has been. */
export class FolderReadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FolderReadError";
	}
}

function tooManyFiles(name: string): FolderReadError {
	return new FolderReadError(
		`${name} has more than ${MAX_FOLDER_FILES.toLocaleString("en-US")} files, more than can be uploaded at once`,
	);
}

/** Raised when the caller's signal fires; named so `isAbortError` sees it. */
function abortError(): Error {
	const error = new Error("Reading cancelled");
	error.name = "AbortError";
	return error;
}

/**
 * Every entry of a directory.
 *
 * `readEntries` answers in batches — Chromium at most 100 at a time — and an
 * empty batch is the only signal that there are no more, so a single call would
 * silently leave the rest of a large directory behind.
 */
async function readAllEntries(
	dir: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
	const reader = dir.createReader();
	const all: FileSystemEntry[] = [];
	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
			reader.readEntries(resolve, reject),
		);
		if (batch.length === 0) return all;
		all.push(...batch);
	}
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Reads a dropped folder through its `FileSystemDirectoryEntry`, keeping each
 * file's path relative to it and every empty directory.
 *
 * The entry has to have been taken from the drop event while it was being
 * dispatched; the walk itself may run long after. Anything unreadable fails the
 * whole folder rather than being left out, since a folder that arrives quietly
 * missing a file is the thing this must never do.
 */
export async function readFolderEntry(
	root: FileSystemDirectoryEntry,
	options: { signal?: AbortSignal; onCount?: (files: number) => void } = {},
): Promise<FolderContents> {
	const { signal, onCount } = options;
	const contents: FolderContents = { files: [], dirs: [] };

	const walk = async (dir: FileSystemDirectoryEntry, prefix: string) => {
		let children: FileSystemEntry[];
		try {
			children = await readAllEntries(dir);
		} catch {
			throw new FolderReadError(`Couldn't read ${root.name}/${prefix}`);
		}
		if (signal?.aborted) throw abortError();
		if (children.length === 0 && prefix !== "") {
			contents.dirs.push(prefix.slice(0, -1));
		}

		for (const child of children) {
			const path = `${prefix}${child.name}`;
			if (child.isDirectory) {
				await walk(child as FileSystemDirectoryEntry, `${path}/`);
				continue;
			}
			let file: File;
			try {
				file = await fileOf(child as FileSystemFileEntry);
			} catch {
				throw new FolderReadError(`Couldn't read ${root.name}/${path}`);
			}
			if (signal?.aborted) throw abortError();
			contents.files.push({ file, path });
			if (contents.files.length > MAX_FOLDER_FILES) {
				throw tooManyFiles(root.name);
			}
			onCount?.(contents.files.length);
		}
	};

	// Raced against the signal rather than only checked between steps: a
	// callback the browser never makes would otherwise hold the walk — and the
	// tab's one-batch-at-a-time gate behind it — open after a cancel.
	await new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const abort = () => reject(abortError());
		signal?.addEventListener("abort", abort, { once: true });
		walk(root, "")
			.then(resolve, reject)
			.finally(() => signal?.removeEventListener("abort", abort));
	});
	return contents;
}

/**
 * The folder a directory picker returned, or null when what it returned is not
 * one — a browser that advertises `webkitdirectory` but opened a plain file
 * picker leaves `webkitRelativePath` empty, and those are just files.
 *
 * A picker never reports an empty directory: it lists files only.
 */
export function folderFromPicked(
	files: File[],
): { name: string; contents: FolderContents } | null {
	if (files.length === 0) return null;
	if (files.some((file) => !file.webkitRelativePath.includes("/"))) {
		return null;
	}
	const name = files[0].webkitRelativePath.split("/")[0];
	return {
		name,
		contents: {
			files: files.map((file) => ({
				file,
				path: file.webkitRelativePath.slice(name.length + 1),
			})),
			dirs: [],
		},
	};
}

/** Why a folder that was read in full still cannot be sent, if it cannot. */
export function folderCountRefusal(
	name: string,
	contents: FolderContents,
): FolderReadError | null {
	return contents.files.length > MAX_FOLDER_FILES ? tooManyFiles(name) : null;
}
