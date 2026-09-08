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

/** Format file path as "filename (relative/dir)" for display */
export function formatFilePath(filePath: string, workDir: string): string {
	const parts = filePath.split("/").filter(Boolean);
	if (parts.length === 0) return filePath;

	const fileName = parts[parts.length - 1];
	if (parts.length === 1) return fileName;

	// If path is within workDir, show relative path
	if (workDir && filePath.startsWith(workDir)) {
		const relativePath = filePath.slice(workDir.length).replace(/^\//, "");
		const relativeParts = relativePath.split("/").filter(Boolean);
		relativeParts.pop();
		if (relativeParts.length === 0) return fileName;
		return `${fileName} (${relativeParts.join("/")})`;
	}

	// For paths outside workDir, show only parent directory
	const parentDir = parts[parts.length - 2];
	return `${fileName} (${parentDir})`;
}
