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

export interface GitCommit {
	hash: string;
	subject: string;
	body?: string;
	author: string;
	date: string;
}

export interface GitLogResult {
	commits: GitCommit[];
}

export interface FileChange {
	path: string;
	status: "M" | "A" | "D" | "R";
}

export type GitFileStatus = "M" | "A" | "D" | "R" | "?";

export const GIT_STATUS_INFO: Record<
	GitFileStatus,
	{ label: string; color: string }
> = {
	M: { label: "Modified", color: "text-th-warning" },
	A: { label: "Added", color: "text-th-success" },
	D: { label: "Deleted", color: "text-th-error" },
	R: { label: "Renamed", color: "text-th-accent" },
	"?": { label: "Untracked", color: "text-th-text-muted" },
};

export interface GitShowResult extends GitCommit {
	files: FileChange[];
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
