export interface FileStatus {
	path: string;
	status: "M" | "A" | "D" | "R" | "?";
}

export interface GitStatus {
	staged: FileStatus[];
	unstaged: FileStatus[];
	submodules?: Record<string, GitStatus>;
}

export interface GitDiffData {
	diff: string;
	old_content: string;
	new_content: string;
}

export interface GitDiffSubscribeResult extends GitDiffData {
	id: string;
}

export interface GitDiffChangedNotification extends GitDiffData {
	id: string;
}

/**
 * Flatten GitStatus into a list of files with full paths.
 * Submodule files are prefixed with their submodule path.
 */
export function flattenGitStatus(
	status: GitStatus,
	prefix = "",
): { staged: FileStatus[]; unstaged: FileStatus[] } {
	const staged: FileStatus[] = status.staged.map((f) => ({
		...f,
		path: prefix ? `${prefix}/${f.path}` : f.path,
	}));
	const unstaged: FileStatus[] = status.unstaged.map((f) => ({
		...f,
		path: prefix ? `${prefix}/${f.path}` : f.path,
	}));

	if (status.submodules) {
		for (const [subPath, subStatus] of Object.entries(status.submodules)) {
			const subPrefix = prefix ? `${prefix}/${subPath}` : subPath;
			const sub = flattenGitStatus(subStatus, subPrefix);
			staged.push(...sub.staged);
			unstaged.push(...sub.unstaged);
		}
	}

	return { staged, unstaged };
}
