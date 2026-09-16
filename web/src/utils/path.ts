/**
 * The directory holding `fullPath`, without a trailing slash; empty is the root.
 *
 * Not `splitPath().directory`, which keeps the slash: this form is what the
 * upload endpoint and the contents query key both expect for a directory.
 */
export function parentDir(fullPath: string): string {
	const lastSlash = fullPath.lastIndexOf("/");
	return lastSlash === -1 ? "" : fullPath.slice(0, lastSlash);
}

/** Whether `path` is `root` itself or something inside it. */
export function isAtOrUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

/**
 * Split a slash-separated path into its file name and directory prefix.
 *
 * Use this for paths in Pockode's own API (git diffs, file listings), which are
 * always slash-separated. Paths in the host filesystem's native form are
 * backslash-separated on Windows; use `splitNativePath` for those.
 */
export function splitPath(fullPath: string): {
	fileName: string;
	directory: string;
} {
	const lastSlash = fullPath.lastIndexOf("/");
	if (lastSlash === -1) {
		return { fileName: fullPath, directory: "" };
	}
	return {
		fileName: fullPath.slice(lastSlash + 1),
		directory: fullPath.slice(0, lastSlash + 1),
	};
}

/**
 * Split a filesystem path into its non-empty segments, accepting either
 * separator.
 *
 * Use this for paths that come from the host filesystem — a tool call's
 * `file_path` (passed through verbatim from the AI CLI) or the server's
 * `work_dir` — because those are in the OS's native form and are
 * backslash-separated on Windows. Paths in Pockode's own API (git diffs, file
 * listings) are always slash-separated; use `splitPath` for those.
 */
export function splitNativePath(path: string): string[] {
	return path.split(/[/\\]/).filter(Boolean);
}

/**
 * `filePath` as a work-directory-relative path in Pockode's own slash form, or
 * null when it names nothing inside the work directory — the work directory
 * itself included, which is not a file the file namespace can serve.
 *
 * This is what decides whether a path an agent produced can be opened at all:
 * every route into a file takes a relative path, so an absolute path outside
 * has no way in.
 */
export function relativeToWorkDir(
	filePath: string,
	workDir: string,
): string | null {
	const parts = splitNativePath(filePath);
	const workDirParts = splitNativePath(workDir);
	// Compare segment by segment rather than as a string prefix: that keeps
	// "/home/me/project2" from matching a work dir of "/home/me/project", and it
	// makes the check insensitive to which separator each side happens to use.
	if (workDirParts.length === 0 || workDirParts.length >= parts.length) {
		return null;
	}
	if (!workDirParts.every((segment, i) => segment === parts[i])) return null;

	const relativeParts = parts.slice(workDirParts.length);
	// A `..` in the remainder walks back out, so the prefix match says nothing
	// about where the path ends up. Every route into a file refuses those
	// anyway; catching it here is what keeps the caller from offering a way
	// over that the server will only reject.
	if (relativeParts.includes("..")) return null;
	return relativeParts.join("/");
}

/** Format a native file path as "filename (relative/dir)" for display */
export function formatFilePath(filePath: string, workDir: string): string {
	const parts = splitNativePath(filePath);
	if (parts.length === 0) return filePath;

	const fileName = parts[parts.length - 1];
	if (parts.length === 1) return fileName;

	const relative = relativeToWorkDir(filePath, workDir);
	if (relative !== null) {
		const relativeDir = splitPath(relative).directory.replace(/\/$/, "");
		return relativeDir === "" ? fileName : `${fileName} (${relativeDir})`;
	}

	// For paths outside workDir, show only parent directory
	const dirParts = parts.slice(0, -1);
	return `${fileName} (${dirParts[dirParts.length - 1]})`;
}
