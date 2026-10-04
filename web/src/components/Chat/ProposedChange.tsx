import { WrapText } from "lucide-react";
import type { ReactNode } from "react";
import type { CodexChangeView } from "../../lib/codexChanges";
import {
	diffSettingsActions,
	useDiffSettingsStore,
} from "../../lib/diffSettingsStore";
import { diffStat } from "../../lib/diffStat";
import type { ProposedChangeData } from "../../lib/proposedChange";
import type { LineCounts } from "../../lib/turnChanges";
import { useWSStore } from "../../lib/wsStore";
import { GIT_STATUS_INFO } from "../../types/git";
import { formatFilePath } from "../../utils/path";
import { DiffViewer, FileContentDisplay } from "../ui";

function changePatches(change: ProposedChangeData): string[] | undefined {
	switch (change.kind) {
		case "edit":
		case "multiEdit":
			return change.patches;
		case "codex":
			return change.changes.flatMap((c) => (c.patch ? [c.patch] : []));
		case "write":
			return undefined;
	}
}

/**
 * `+N −M`, with a side that is zero or unknown left out rather than `−0`.
 * Muted for a change that was never applied: the counts still say what was
 * asked, but green and red would read as lines that changed.
 */
export function LineCountsLabel({
	lines,
	muted = false,
}: {
	lines: LineCounts | null;
	muted?: boolean;
}) {
	if (!lines) return null;
	const { added, removed = 0 } = lines;
	if (added === 0 && removed === 0) return null;
	return (
		<span
			className={`flex shrink-0 gap-1.5 font-mono tabular-nums ${muted ? "text-th-text-muted" : ""}`}
		>
			{added > 0 && (
				<span className={muted ? "" : "text-th-success"}>+{added}</span>
			)}
			{/* Read as two figures, not one, by anything that takes the text. */}
			{added > 0 && removed > 0 && " "}
			{/* U+2212, the minus sign: a hyphen is narrower than the plus. */}
			{removed > 0 && (
				<span className={muted ? "" : "text-th-error"}>−{removed}</span>
			)}
		</span>
	);
}

/**
 * What a change's header says and offers: how many lines it adds and removes,
 * and a switch to wrap long lines. Nothing for a new file, which is content
 * rather than a diff — every line of it would count as added, overwritten or
 * not.
 *
 * A change the tool refused says so first: the view draws the input, which
 * looks exactly like a change that landed.
 */
export function proposedChangeHeader(
	change: ProposedChangeData | null,
	{ applied = true }: { applied?: boolean } = {},
): {
	meta?: ReactNode;
	actions?: ReactNode;
} {
	if (!change) return {};
	// No `·` before it: the header already sets meta off from the label by a
	// gap, and a dot inside that gap sat closer to the words after it than to
	// the label before.
	const notApplied = !applied && <span>not applied</span>;
	const patches = changePatches(change);
	// A Codex change of hunkless files only (an empty add, a pure rename) has
	// nothing to count and nothing to wrap.
	if (!patches?.length) return notApplied ? { meta: notApplied } : {};
	return {
		meta: (
			<span className="flex items-baseline gap-1.5">
				{notApplied}
				{notApplied && " "}
				<LineCountsLabel lines={diffStat(patches)} muted={!applied} />
			</span>
		),
		actions: <WrapLinesToggle />,
	};
}

function WrapLinesToggle() {
	const wrap = useDiffSettingsStore((s) => s.wrapLines);
	return (
		<button
			type="button"
			aria-label="Wrap long lines"
			aria-pressed={wrap}
			onClick={diffSettingsActions.toggleWrapLines}
			className={`touch-target flex size-6 items-center justify-center rounded hover:bg-th-overlay-hover hover:text-th-text-primary ${
				wrap ? "bg-th-bg-tertiary text-th-text-primary" : "text-th-text-muted"
			}`}
		>
			<WrapText size={14} aria-hidden="true" />
		</button>
	);
}

function PatchList({
	fileName,
	patches,
}: {
	fileName: string;
	patches: string[];
}) {
	const wrap = useDiffSettingsStore((s) => s.wrapLines);
	return (
		<div className="space-y-2">
			{patches.map((patch, index) => (
				<DiffViewer
					// biome-ignore lint/suspicious/noArrayIndexKey: an input's patches are fixed
					key={index}
					fileName={fileName}
					hunks={[patch]}
					wrap={wrap}
				/>
			))}
		</div>
	);
}

function CodexDiff({ changes }: { changes: CodexChangeView[] }) {
	const workDir = useWSStore((s) => s.workDir);

	return (
		<div className="space-y-3">
			{changes.map((change) => (
				<div key={change.path} className="space-y-1">
					<div className="flex items-center gap-2 text-sm">
						<span
							className={`shrink-0 font-mono ${GIT_STATUS_INFO[change.status].color}`}
							// "?" means an unknown change type here, not git's "Untracked".
							title={
								change.status === "?"
									? change.note
									: GIT_STATUS_INFO[change.status].label
							}
						>
							{change.status}
						</span>
						<span
							className="truncate text-th-text-primary"
							title={change.newPath}
						>
							{formatFilePath(change.newPath, workDir)}
						</span>
					</div>
					{change.newPath !== change.path && (
						<div className="text-th-text-muted text-xs" title={change.path}>
							from {formatFilePath(change.path, workDir)}
						</div>
					)}
					{change.patch ? (
						<PatchList fileName={change.newPath} patches={[change.patch]} />
					) : (
						<p className="text-th-text-muted">
							{change.note ?? "No diff to show"}
						</p>
					)}
				</div>
			))}
		</div>
	);
}

export function ProposedChange({ change }: { change: ProposedChangeData }) {
	switch (change.kind) {
		case "edit":
		case "multiEdit":
			return (
				<PatchList fileName={change.input.file_path} patches={change.patches} />
			);
		case "write":
			return (
				// Its copy button is the block header's (`proposedChangeText`).
				<FileContentDisplay
					content={change.input.content}
					filePath={change.input.file_path}
					copyable={false}
				/>
			);
		case "codex":
			return <CodexDiff changes={change.changes} />;
	}
}
