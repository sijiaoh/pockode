import { WrapText } from "lucide-react";
import type { ReactNode } from "react";
import type { CodexChangeView } from "../../lib/codexChanges";
import {
	diffSettingsActions,
	useDiffSettingsStore,
} from "../../lib/diffSettingsStore";
import { diffStat } from "../../lib/diffStat";
import type { ProposedChangeData } from "../../lib/proposedChange";
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
 * What a change's header says and offers: how many lines it adds and removes,
 * and a switch to wrap long lines. Nothing for a new file, which is content
 * rather than a diff — every line of it would count as added, overwritten or
 * not.
 */
export function proposedChangeHeader(change: ProposedChangeData | null): {
	meta?: ReactNode;
	actions?: ReactNode;
} {
	const patches = change && changePatches(change);
	// A Codex change of hunkless files only (an empty add, a pure rename) has
	// nothing to count and nothing to wrap.
	if (!patches?.length) return {};
	const { added, removed } = diffStat(patches);
	return {
		meta: (
			<span className="font-mono">
				<span className="text-th-success">+{added}</span>{" "}
				<span className="text-th-error">−{removed}</span>
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
