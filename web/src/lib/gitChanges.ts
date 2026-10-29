import type { FileStatus, GitStatus, LineStat } from "../types/git";

/**
 * One changed path as the review walks it: both sides of the file in one
 * record. The Changes list draws each side as a row of its own group
 * (`groupChanges`, docs/git-changes-ui.md).
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
	/**
	 * The index holds unresolved conflicts for the path. Such a record has
	 * neither side: what git lists on its two sides are conflict codes, not
	 * changes, and drawn as sides they would read as a partly staged file whose
	 * stage button stages it — recording the markers as the resolution
	 * (docs/git-conflict-ui.md, The Changes list).
	 */
	conflict?: ConflictKind;
}

/**
 * Read from the two letters git gives a conflicted path: `D` on both sides,
 * `D` on one, or anything else (`UU`, `AA`, `AU`, `UA`).
 */
export type ConflictKind = "content" | "deleted-one-side" | "deleted-both";

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
	const conflicted: string[] = [];
	const visit = (s: GitStatus, prefix: string) => {
		const prefixed = (p: string) => (prefix ? `${prefix}/${p}` : p);
		for (const p of s.conflicted ?? []) conflicted.push(prefixed(p));
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
	for (const path of conflicted) {
		const file = byPath.get(path);
		// Always found: a conflicted path is on both sides too.
		if (!file) continue;
		const deletions = [file.staged, file.unstaged].filter(
			(side) => side?.status === "D",
		).length;
		file.conflict =
			deletions === 2
				? "deleted-both"
				: deletions === 1
					? "deleted-one-side"
					: "content";
		delete file.staged;
		delete file.unstaged;
	}
	return [...byPath.values()];
}

/**
 * The Changes list's groups, each a list of one-sided rows in `files`' order:
 * a partly staged file has a row in both `unstaged` and `staged`, and a
 * conflict, which has no side, is in `conflicts` alone.
 */
export interface ChangeGroups {
	conflicts: ChangedFile[];
	unstaged: ChangedFile[];
	staged: ChangedFile[];
}

export function groupChanges(files: ChangedFile[]): ChangeGroups {
	const groups: ChangeGroups = { conflicts: [], unstaged: [], staged: [] };
	for (const file of files) {
		if (file.conflict) {
			groups.conflicts.push(file);
			continue;
		}
		if (file.unstaged) groups.unstaged.push(sideOnly(file, false));
		if (file.staged) groups.staged.push(sideOnly(file, true));
	}
	return groups;
}

/**
 * `file` with only one of its sides, so that what is read off a row — its
 * kind, its counts — describes that side alone.
 */
export function sideOnly(file: ChangedFile, staged: boolean): ChangedFile {
	return staged
		? { ...file, unstaged: undefined }
		: { ...file, staged: undefined };
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
	// The conflict is in the working tree, and there is no staged version yet.
	if (file.conflict) return false;
	if (staged ? file.staged : file.unstaged) return staged;
	return !file.unstaged;
}

/**
 * Whether the server sends no hunk IDs for the side whatever the whitespace
 * setting, so it can only be staged whole: binary, conflicted, or turned into
 * a symlink or back (docs/git.md#staging-hunks). A conflict is read from
 * `conflict`, since collectChanges leaves such a record without sides.
 */
export function stagesOnlyWhole(file: ChangedFile, staged: boolean): boolean {
	const side = staged ? file.staged : file.unstaged;
	return !!file.conflict || !!side?.binary || side?.status === "T";
}

export function changeKindOf(file: ChangedFile): ChangeKind {
	// A conflict deleted on one side still has the other side's file on disk.
	if (file.conflict) {
		return file.conflict === "deleted-both" ? "deleted" : "modified";
	}
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
 * The one ordering of changed paths, shared by the list and the review: each
 * of the list's groups draws its rows in it, and the review walks the files
 * in it.
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
 * Where a review entered from outside a file starts: the first file in review
 * order, on the side `reviewSideOf` opens — the chat's review row starts here
 * (docs/agent-handoff-ui.md §2.5). Not necessarily the list's first row, which
 * is the first conflict or unstaged change.
 * Null for a clean tree.
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
