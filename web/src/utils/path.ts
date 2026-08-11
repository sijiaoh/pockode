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

/** Format a native file path as "filename (relative/dir)" for display */
export function formatFilePath(filePath: string, workDir: string): string {
	const parts = splitNativePath(filePath);
	if (parts.length === 0) return filePath;

	const fileName = parts[parts.length - 1];
	if (parts.length === 1) return fileName;

	const dirParts = parts.slice(0, -1);
	const workDirParts = splitNativePath(workDir);
	// Compare segment by segment rather than as a string prefix: that keeps
	// "/home/me/project2" from matching a work dir of "/home/me/project", and it
	// makes the check insensitive to which separator each side happens to use.
	const withinWorkDir =
		workDirParts.length > 0 &&
		workDirParts.length <= dirParts.length &&
		workDirParts.every((segment, i) => segment === dirParts[i]);

	if (withinWorkDir) {
		const relativeParts = dirParts.slice(workDirParts.length);
		if (relativeParts.length === 0) return fileName;
		return `${fileName} (${relativeParts.join("/")})`;
	}

	// For paths outside workDir, show only parent directory
	return `${fileName} (${dirParts[dirParts.length - 1]})`;
}
