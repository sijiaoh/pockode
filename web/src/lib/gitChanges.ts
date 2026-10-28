import type { FileStatus, GitStatus, LineStat } from "../types/git";

/**
 * One changed path as the Changes list and the review show it: both sides of
 * the file in one record, so that staging is a property of the row rather than
 * the list it sits in (docs/git-changes-ui.md).
 */
export interface ChangedFile {
	/** Relative to the root repository; a submodule's file carries its prefix. */
	path: string;
	/** HEAD → index. Paths in it, `orig_path` too, carry the prefix as well. */
	staged?: FileStatus;
	/** Index → working tree, untracked included. */
	unstaged?: FileStatus;
	/** Inside a submodule: staged in its own index, out of a root commit's reach. */
	submodule: boolean;
}

/** `mixed` only ever comes from staging done elsewhere, never from a tap. */
export type CheckState = "checked" | "unchecked" | "mixed";

export type ChangesView = "flat" | "tree";

export type ChangeKind =
	| "modified"
	| "added"
	| "untracked"
	| "deleted"
	| "renamed";

/** Every changed path in `status`, one record per path, in no particular order. */
export function collectChanges(status: GitStatus): ChangedFile[] {
	const byPath = new Map<string, ChangedFile>();
	const visit = (s: GitStatus, prefix: string) => {
		const prefixed = (p: string) => (prefix ? `${prefix}/${p}` : p);
		const entry = (f: FileStatus) => {
			const path = prefixed(f.path);
			let file = byPath.get(path);
			if (!file) {
				file = { path, submodule: prefix !== "" };
				byPath.set(path, file);
			}
			const side: FileStatus = { ...f, path };
			if (f.orig_path) side.orig_path = prefixed(f.orig_path);
			return { file, side };
		};
		for (const f of s.staged) {
			const { file, side } = entry(f);
			file.staged = side;
		}
		for (const f of s.unstaged) {
			const { file, side } = entry(f);
			file.unstaged = side;
		}
		for (const [sub, subStatus] of Object.entries(s.submodules ?? {})) {
			visit(subStatus, prefix ? `${prefix}/${sub}` : sub);
		}
	};
	visit(status, "");
	return [...byPath.values()];
}

export function checkStateOf(file: ChangedFile): CheckState {
	if (!file.staged) return "unchecked";
	return file.unstaged ? "mixed" : "checked";
}

/**
 * The state of a checkbox standing for several files — a folder, or select
 * all: checked when every file is fully staged, unchecked when none has
 * anything staged.
 */
export function aggregateCheckState(files: ChangedFile[]): CheckState {
	const states = new Set(files.map(checkStateOf));
	if (states.size === 1 && !states.has("mixed")) {
		return states.has("checked") ? "checked" : "unchecked";
	}
	return states.size === 0 ? "unchecked" : "mixed";
}

/**
 * What pressing a checkbox over `files` writes. Mixed goes to checked — the
 * press is "include these", and a partial staging was made on purpose — so
 * only a checked box unstages.
 *
 * `staged` is in `useGitWriteRunner().toggle`'s terms: true unstages.
 */
export function checkboxWrite(files: ChangedFile[]): {
	paths: string[];
	staged: boolean;
} {
	if (aggregateCheckState(files) === "checked") {
		return { paths: files.flatMap(unstagePaths), staged: true };
	}
	return {
		paths: files.filter((f) => f.unstaged).map((f) => f.path),
		staged: false,
	};
}

/**
 * The paths that unstage `file` whole. A staged rename names its source too:
 * the rename is a deletion of the old path and an addition of the new one in
 * the index, and restoring the new path alone would leave the file split into
 * `Deleted` and `Untracked`.
 */
export function unstagePaths(file: ChangedFile): string[] {
	return file.staged?.status === "R" && file.staged.orig_path
		? [file.path, file.staged.orig_path]
		: [file.path];
}

/**
 * Which side of `file` the review shows when `staged` is asked for: that one if
 * the file has it, else the one it has. A file with both opens unstaged — what
 * staging would add — and a side that stops existing gives way to the other.
 */
export function reviewSideOf(file: ChangedFile, staged: boolean): boolean {
	if (staged ? file.staged : file.unstaged) return staged;
	return !file.unstaged;
}

/**
 * Whether the server sends no hunk IDs for the side whatever the whitespace
 * setting, so it can only be staged whole: binary, conflicted, or turned into
 * a symlink or back (docs/git.md#staging-hunks). A conflict is `U` on either
 * side, or both sides added or both deleted, as git's porcelain has it.
 */
export function stagesOnlyWhole(file: ChangedFile, staged: boolean): boolean {
	const side = staged ? file.staged : file.unstaged;
	const both = `${file.staged?.status}${file.unstaged?.status}`;
	return (
		!!side?.binary ||
		side?.status === "T" ||
		file.staged?.status === "U" ||
		file.unstaged?.status === "U" ||
		both === "AA" ||
		both === "DD"
	);
}

export function changeKindOf(file: ChangedFile): ChangeKind {
	if (file.unstaged?.status === "?") return "untracked";
	if (file.unstaged?.status === "D" || file.staged?.status === "D") {
		return "deleted";
	}
	if (file.staged?.status === "R") return "renamed";
	if (file.staged?.status === "A") return "added";
	return "modified";
}

/**
 * The file's whole change: the sum of its two sides, which is exactly the two
 * diffs the review shows for it. `lines` is null when neither side could be
 * counted; `binary` then says whether that is because the file is binary.
 */
export function lineStatOf(file: ChangedFile): {
	lines: LineStat | null;
	binary: boolean;
} {
	const sides = [file.staged, file.unstaged].filter(
		(s): s is FileStatus => s !== undefined,
	);
	const counted = sides.flatMap((s) => (s.lines ? [s.lines] : []));
	if (counted.length === 0) {
		return { lines: null, binary: sides.some((s) => s.binary) };
	}
	return { lines: addLines(counted), binary: false };
}

/** The sum over files that have counts; null when none of them has. */
export function sumLines(files: ChangedFile[]): LineStat | null {
	const counted = files.flatMap((f) => {
		const { lines } = lineStatOf(f);
		return lines ? [lines] : [];
	});
	return counted.length === 0 ? null : addLines(counted);
}

function addLines(stats: LineStat[]): LineStat {
	return stats.reduce(
		(sum, s) => ({
			additions: sum.additions + s.additions,
			deletions: sum.deletions + s.deletions,
		}),
		{ additions: 0, deletions: 0 },
	);
}

/** Case-insensitive, with the exact string breaking ties so the order is total. */
function compareText(a: string, b: string): number {
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	if (la !== lb) return la < lb ? -1 : 1;
	return a === b ? 0 : a < b ? -1 : 1;
}

/** `/` before any other character, so a folder's files stay together. */
function compareFlat(a: string, b: string): number {
	return compareText(a.replaceAll("/", "\0"), b.replaceAll("/", "\0"));
}

/**
 * The order a depth-first walk of the tree reads on screen: at each level
 * folders first, then files, each by name. Compacting single-child folders
 * into one row does not change it.
 */
function compareTree(a: string, b: string): number {
	const sa = a.split("/");
	const sb = b.split("/");
	for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
		// Before the names: a deleted file `a` and a new folder `a/` share a
		// segment, and the tree still draws the folder first.
		const aIsFolder = i < sa.length - 1;
		const bIsFolder = i < sb.length - 1;
		if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
		if (sa[i] === sb[i]) continue;
		return compareText(sa[i], sb[i]);
	}
	return sa.length - sb.length;
}

/**
 * The one ordering of changed paths, shared by the list and the review: the
 * review walks the files in the order the list draws them.
 */
export function compareChangePaths(
	view: ChangesView,
): (a: string, b: string) => number {
	return view === "tree" ? compareTree : compareFlat;
}

export function orderChanges(
	files: ChangedFile[],
	view: ChangesView,
): ChangedFile[] {
	const compare = compareChangePaths(view);
	return [...files].sort((a, b) => compare(a.path, b.path));
}

/**
 * Where a review entered from outside a file starts: the first file in the
 * list's order, on the side `reviewSideOf` opens. The Changes list's `Review`
 * and the chat's review row both start here, so they never start at different
 * files (docs/agent-handoff-ui.md §2.5). Null for a clean tree.
 */
export function firstReviewTarget(
	files: ChangedFile[],
	view: ChangesView,
): { path: string; staged: boolean } | null {
	const [first] = orderChanges(files, view);
	return first
		? { path: first.path, staged: reviewSideOf(first, false) }
		: null;
}

/**
 * The file after (`1`) or before (`-1`) `path` in the current list, found by
 * position in the order rather than by index: `path` need not be in `files`
 * any more, and a file added or dropped elsewhere meanwhile never makes the
 * review skip one or land on the same one twice.
 */
export function adjacentChange(
	files: ChangedFile[],
	view: ChangesView,
	path: string,
	direction: 1 | -1,
): ChangedFile | null {
	const compare = compareChangePaths(view);
	let best: ChangedFile | null = null;
	for (const f of files) {
		const c = compare(f.path, path) * direction;
		if (c <= 0) continue;
		if (!best || compare(f.path, best.path) * direction < 0) best = f;
	}
	return best;
}

/** A folder row of the tree; `name` may span several levels once compacted. */
export interface ChangeFolder {
	name: string;
	/** The deepest folder the row stands for. */
	path: string;
	folders: ChangeFolder[];
	files: ChangedFile[];
}

/**
 * The tree of `files` under an unnamed root, sorted as `compareChangePaths`
 * orders it, with chains of single-child folders compacted into one row
 * (`web/src/components`) as editors do.
 */
export function buildChangeTree(files: ChangedFile[]): ChangeFolder {
	const root: ChangeFolder = { name: "", path: "", folders: [], files: [] };
	for (const file of files) {
		const segments = file.path.split("/");
		let folder = root;
		for (const segment of segments.slice(0, -1)) {
			let child = folder.folders.find((f) => f.name === segment);
			if (!child) {
				child = {
					name: segment,
					path: folder.path ? `${folder.path}/${segment}` : segment,
					folders: [],
					files: [],
				};
				folder.folders.push(child);
			}
			folder = child;
		}
		folder.files.push(file);
	}
	return finishFolder(root, true);
}

function finishFolder(folder: ChangeFolder, isRoot: boolean): ChangeFolder {
	let current = folder;
	while (
		!isRoot &&
		current.files.length === 0 &&
		current.folders.length === 1
	) {
		const only = current.folders[0];
		current = { ...only, name: `${current.name}/${only.name}` };
	}
	return {
		...current,
		folders: current.folders
			.map((f) => finishFolder(f, false))
			// By the level's own segment, not the compacted name: `src/lib` must
			// sort as `src` does, or `src-old` would come first here and second
			// in `compareTree`.
			.sort((a, b) => compareText(firstSegment(a.name), firstSegment(b.name))),
		files: [...current.files].sort((a, b) => compareTree(a.path, b.path)),
	};
}

function firstSegment(name: string): string {
	const slash = name.indexOf("/");
	return slash === -1 ? name : name.slice(0, slash);
}

/** Every file under `folder`, at any depth, in tree order. */
export function filesUnder(folder: ChangeFolder): ChangedFile[] {
	return [...folder.folders.flatMap(filesUnder), ...folder.files];
}
