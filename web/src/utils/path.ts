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
