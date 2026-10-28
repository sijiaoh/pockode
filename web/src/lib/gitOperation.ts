import { JSONRPCErrorException } from "json-rpc-2.0";
import type {
	GitHead,
	GitOperation,
	GitOperationCommit,
	GitOperationKind,
} from "../types/git";
import { describeGitFailure, type GitFailure } from "../utils/gitErrors";
import { compareChangePaths } from "./gitChanges";

/**
 * Every sentence the workspace says about a merge, rebase, cherry-pick or
 * revert left in progress (docs/git-conflict-ui.md). Pure, so the copy is
 * tested without a screen; a part git could not tell is left out, never shown
 * as a placeholder.
 */

/** HEAD's branch, and null while detached or not yet known. */
export function headBranchOf(head: GitHead | undefined): string | null {
	return head && !head.detached ? head.branch : null;
}

/** The branch an operation is on, and null for a detached HEAD. */
export function operationBranch(
	operation: GitOperation,
	headBranch: string | null,
): string | null {
	// A rebase detaches HEAD, so its branch is the one the server read from the
	// rebase's own state.
	if (operation.kind === "rebase") return operation.branch ?? null;
	return headBranch;
}

/**
 * The branch to name in the top bar while a rebase rewrites it, instead of
 * the detached HEAD it is standing on.
 */
export function rebasingBranch(
	operation: GitOperation | undefined,
): string | null {
	return operation?.kind === "rebase" ? (operation.branch ?? null) : null;
}

/** Identifies one operation, for what is remembered only while it lasts. */
export function operationKey(operation: GitOperation): string {
	// A rebase replays a different commit at every step, and is still the one
	// rebase: what it rewrites and what it lands on say which.
	if (operation.kind === "rebase") {
		return `rebase:${operation.branch ?? ""}:${operation.onto?.hash ?? ""}`;
	}
	return `${operation.kind}:${operation.commit?.hash ?? ""}`;
}

export function shortHash(hash: string): string {
	return hash.slice(0, 7);
}

/** A commit by the branch that points at it, else by its short hash. */
function commitName(commit: GitOperationCommit | undefined): string | null {
	if (!commit) return null;
	return commit.ref || shortHash(commit.hash);
}

/** The banner's conflicted files: the Changes list's flat order. */
export function orderConflicted(paths: readonly string[]): string[] {
	return [...paths].sort(compareChangePaths("flat"));
}

const KIND_TITLE: Record<GitOperationKind, string> = {
	merge: "Merge",
	rebase: "Rebase",
	"cherry-pick": "Cherry-pick",
	revert: "Revert",
};

/** A piece of the context line; `name` is a branch or ref, set in mono. */
export interface TextPart {
	text: string;
	name?: true;
}

export interface OperationDescription {
	title: string;
	/** What is combined with what; null when nothing of it is known. */
	context: TextPart[] | null;
	/** `3 of 7`, a rebase's step; null when git does not keep count. */
	progress: string | null;
	/** The commit being applied, hash first; null when there is none. */
	commitLine: { prefix: string | null; hash: string; subject: string } | null;
	/** In place of the file list when nothing is conflicted any more. */
	noConflictsLine: string;
	pauseSentence: string;
	primaryLabel: string;
}

export function describeOperation(
	operation: GitOperation,
	conflictCount: number,
	headBranch: string | null,
): OperationDescription {
	const { kind, step } = operation;
	const branch = operationBranch(operation, headBranch);
	const hasConflicts = conflictCount > 0;
	const progress = step ? `${step.current} of ${step.total}` : null;

	const title = hasConflicts
		? `${KIND_TITLE[kind]} stopped on conflicts`
		: kind === "rebase"
			? "Rebase paused"
			: `${KIND_TITLE[kind]} not finished`;

	const commit = operation.commit;
	const commitLine =
		kind === "merge" || !commit
			? null
			: {
					prefix: kind === "rebase" ? "At" : null,
					hash: shortHash(commit.hash),
					subject: commit.subject,
				};

	const noConflictsLine =
		kind === "rebase"
			? `No conflicts left. The rebase is paused${
					progress ? ` at step ${progress}` : ""
				}.`
			: `No conflicts left. The ${kind} still has to be finished.`;

	return {
		title,
		context: contextLine(operation, branch),
		progress,
		commitLine,
		noConflictsLine,
		pauseSentence: `Commits and branch switches are paused until the ${kind} is finished or aborted.`,
		primaryLabel: hasConflicts ? "Resolve with agent" : "Finish with agent",
	};
}

/**
 * Why the Branches list stops switching, pinned at its top where a failed
 * switch's refusal goes; `New branch…` stops for the same reason.
 */
export function branchSwitchPausedReason(kind: GitOperationKind): string {
	return `Branch switching is paused during the ${kind}. Abort it, or let the agent finish it.`;
}

/** Why the Sync sheet's pull is disabled — said rather than relaying git's refusal. */
export function pullPausedReason(kind: GitOperationKind): string {
	return `Can't pull during a ${kind}.`;
}

function contextLine(
	operation: GitOperation,
	branch: string | null,
): TextPart[] | null {
	const parts: TextPart[] = [];
	const word = (text: string) => parts.push({ text });
	const name = (text: string) => parts.push({ text, name: true });

	switch (operation.kind) {
		case "merge": {
			const incoming = commitName(operation.commit);
			word("Merging");
			if (incoming) name(incoming);
			if (branch) {
				word("into");
				name(branch);
			}
			break;
		}
		case "rebase": {
			const onto = commitName(operation.onto);
			word("Rebasing");
			if (branch) name(branch);
			if (onto) {
				word("onto");
				name(onto);
			}
			break;
		}
		case "cherry-pick":
			if (!branch) return null;
			word("Picking onto");
			name(branch);
			break;
		case "revert":
			if (!branch) return null;
			word("Reverting on");
			name(branch);
			break;
	}
	// A bare verb says nothing the title has not.
	return parts.length > 1 ? parts : null;
}

/** Where a prompt stops listing paths: the agent can list the rest itself. */
export const PROMPT_PATH_LIMIT = 20;

/**
 * What `Resolve with agent` puts in the composer. Built from the state at the
 * press, never from what the banner rendered a moment earlier.
 *
 * Without an operation the conflicts are all there is to say — a `git stash
 * pop` leaves them with nothing to continue — which the conflict view's
 * `Ask agent` still hands over.
 */
export function describeOperationPrompt(
	operation: GitOperation | undefined,
	conflicted: readonly string[],
	headBranch: string | null,
): string {
	const opening = operation
		? `The repository is in the middle of ${promptClause(
				operation,
				operationBranch(operation, headBranch),
			)}`
		: "The repository has unresolved conflicts";

	if (conflicted.length === 0) {
		return operation
			? `${opening}. There are no conflicts left. Check the result, then finish the ${operation.kind}.`
			: `${opening}.`;
	}

	const paths = orderConflicted(conflicted);
	const listed = paths.slice(0, PROMPT_PATH_LIMIT).map((p) => `- ${p}`);
	if (paths.length > PROMPT_PATH_LIMIT) {
		listed.push(
			`- … and ${paths.length - PROMPT_PATH_LIMIT} more (see git status)`,
		);
	}
	const after = operation
		? `Stage each file once it is resolved, then continue the ${operation.kind}.`
		: "Stage each file once it is resolved.";
	return [
		operation ? `${opening}, stopped on conflicts in:` : `${opening} in:`,
		...listed,
		"",
		`Resolve these conflicts, keeping what both sides meant. ${after} If a conflict cannot be resolved safely, stop and explain it instead of guessing.`,
	].join("\n");
}

function quotedCommit(commit: GitOperationCommit): string {
	return `${shortHash(commit.hash)} "${commit.subject}"`;
}

function promptClause(operation: GitOperation, branch: string | null): string {
	const { commit } = operation;
	const words: string[] = [];
	switch (operation.kind) {
		case "merge": {
			const incoming = commitName(commit);
			words.push("a merge");
			if (incoming) words.push(`of ${incoming}`);
			if (branch) words.push(`into ${branch}`);
			break;
		}
		case "rebase": {
			const onto = commitName(operation.onto);
			words.push("a rebase");
			if (branch) words.push(`of ${branch}`);
			if (onto) words.push(`onto ${onto}`);
			const details: string[] = [];
			if (operation.step) {
				details.push(
					`step ${operation.step.current} of ${operation.step.total}`,
				);
			}
			if (commit) details.push(`replaying ${quotedCommit(commit)}`);
			if (details.length > 0) words.push(`(${details.join(", ")})`);
			break;
		}
		case "cherry-pick":
			words.push("a cherry-pick");
			if (commit) words.push(`of ${quotedCommit(commit)}`);
			if (branch) words.push(`onto ${branch}`);
			break;
		case "revert":
			words.push("a revert");
			if (commit) words.push(`of ${quotedCommit(commit)}`);
			if (branch) words.push(`on ${branch}`);
			break;
	}
	return words.join(" ");
}

export interface AbortCopy {
	title: string;
	message: string;
	confirmLabel: string;
}

/** The confirmation before `git.abort`: what goes back, and what is lost. */
export function describeAbort(
	operation: GitOperation,
	conflictCount: number,
	headBranch: string | null,
): AbortCopy {
	const { kind, commit, step } = operation;
	const branch = operationBranch(operation, headBranch) ?? "HEAD";
	const resolutions =
		conflictCount > 0
			? "conflicts resolved so far"
			: "the finished resolutions";

	let back: string;
	let lost = `${capitalize(resolutions)} are lost and cannot be recovered.`;
	switch (kind) {
		case "merge": {
			const incoming = commitName(commit);
			back = incoming ? `before ${incoming} was merged in` : "before the merge";
			break;
		}
		case "rebase": {
			back = "before the rebase";
			const replayed = step ? step.current - 1 : 0;
			if (replayed > 0) {
				const commits =
					replayed === 1
						? "The commit already replayed"
						: `The ${replayed} commits already replayed`;
				const rest = conflictCount > 0 ? `any ${resolutions}` : resolutions;
				lost = `${commits} and ${rest} are lost and cannot be recovered.`;
			}
			break;
		}
		case "cherry-pick":
		case "revert": {
			// Not "before picking <commit>": in a sequence of several, the abort
			// also undoes the commits already made for the earlier ones. Between
			// two of them, commits may have been made on the branch since it
			// began, and git leaves those where they are.
			back = commit
				? `before the ${kind} began`
				: `before the ${kind}, unless commits were made on it since — git keeps those`;
			break;
		}
	}

	return {
		title: `Abort the ${kind}?`,
		message: `${branch} goes back to how it was ${back}. ${lost}`,
		confirmLabel: `Abort ${kind}`,
	};
}

/**
 * Where: server/rpc/types.go's CodeGitOperationChanged. The operation the
 * user confirmed is no longer the one in progress, and nothing ran.
 */
const OPERATION_CHANGED_CODE = -32005;

/** The kind in progress now when the server refused for that reason. */
export function changedOperation(
	error: unknown,
): { current: GitOperationKind | null } | null {
	if (
		!(error instanceof JSONRPCErrorException) ||
		error.code !== OPERATION_CHANGED_CODE
	) {
		return null;
	}
	const current = (error.data as { current?: unknown } | undefined)?.current;
	return {
		current:
			typeof current === "string" && current !== ""
				? (current as GitOperationKind)
				: null,
	};
}

/**
 * How a failed abort reads, or null when there is nothing to say: the
 * operation already ended, and the banner is leaving with it.
 */
export function describeAbortFailure(
	error: unknown,
	kind: GitOperationKind,
): GitFailure | null {
	const changed = changedOperation(error);
	if (changed) {
		if (!changed.current) return null;
		return {
			summary: `The ${kind} is no longer in progress — a ${changed.current} is. Nothing was aborted.`,
			detail: null,
		};
	}
	return describeGitFailure(error, () => `Could not abort the ${kind}.`);
}

/**
 * Said after an abort git ended without moving the branch back, since the
 * user confirmed losing work that is in fact still there.
 */
export function describeHeadKept(
	kind: GitOperationKind,
	branch: string | null,
): string {
	return `The ${kind} has ended, but the commits made during it are still on ${
		branch ?? "HEAD"
	}. The branch was not moved back.`;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One conflict in a file's text, by 0-based line: `<<<<<<<` at `start`, the
 * diff3 `|||||||` at `base` when there is one, `=======` at `separator`,
 * `>>>>>>>` at `end`.
 */
export interface ConflictRegion {
	start: number;
	base?: number;
	separator: number;
	end: number;
}

// Seven characters and then a space or the end of the line, as git writes
// them (conflict-marker-size's default) and as rerere reads them: eight `<`
// are text. `\r?` for a file with CRLF endings.
const OPEN_MARKER = /^<{7}(?: |\r?$)/;
const BASE_MARKER = /^\|{7}(?: |\r?$)/;
const SEPARATOR_MARKER = /^={7}\r?$/;
const CLOSE_MARKER = /^>{7}(?: |\r?$)/;

/**
 * The conflicts left in a working-tree file, in order. Only markers that pair
 * up count: a marker out of place starts nothing, and an opening marker that
 * is opened again before it closes is dropped for the later one — the text
 * between is not shown as a conflict it may not be.
 */
export function findConflictRegions(text: string): ConflictRegion[] {
	const regions: ConflictRegion[] = [];
	let open: Partial<ConflictRegion> | null = null;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (OPEN_MARKER.test(line)) {
			open = { start: i };
			continue;
		}
		if (!open) continue;
		if (BASE_MARKER.test(line)) {
			const inPlace = open.base === undefined && open.separator === undefined;
			if (inPlace) open.base = i;
			else open = null;
		} else if (SEPARATOR_MARKER.test(line)) {
			if (open.separator === undefined) open.separator = i;
			else open = null;
		} else if (CLOSE_MARKER.test(line)) {
			if (open.separator !== undefined) {
				regions.push({ ...(open as ConflictRegion), end: i });
			}
			open = null;
		}
	}
	return regions;
}

// Any length: a `conflict-marker-size` attribute makes them longer, and the
// regions above are not found then. The diff3 base marker counts too: deleting
// only the outer two leaves the ancestor's text behind it.
const ANY_MARKER = /^(?:<{7,}|>{7,}|\|{7,})(?: |\r?$)/m;

/**
 * Whether the text still holds an opening, closing or base marker, paired or
 * not — what `Mark resolved` waits on. Stricter than the regions: a region a
 * stray line broke up is shown plain, and still must not be recorded as
 * resolved. A bare `=======` alone is text (a setext heading).
 */
export function hasConflictMarkers(text: string): boolean {
	return ANY_MARKER.test(text);
}

/** Whether a 0-based line is one of a region's marker lines. */
export function isMarkerLine(region: ConflictRegion, line: number): boolean {
	return (
		line === region.start ||
		line === region.base ||
		line === region.separator ||
		line === region.end
	);
}
