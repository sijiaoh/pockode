import { createPatch } from "diff";
import { useMemo } from "react";
import type { CodexChangeView } from "../../lib/codexChanges";
import type {
	EditInput,
	MultiEditInput,
	ProposedChangeData,
} from "../../lib/proposedChange";
import { useWSStore } from "../../lib/wsStore";
import { GIT_STATUS_INFO } from "../../types/git";
import { formatFilePath } from "../../utils/path";
import { DiffViewer, FileContentDisplay } from "../ui";

function EditDiff({ input }: { input: EditInput }) {
	const unifiedDiff = useMemo(
		() => createPatch(input.file_path, input.old_string, input.new_string),
		[input.file_path, input.old_string, input.new_string],
	);

	return <DiffViewer fileName={input.file_path} hunks={[unifiedDiff]} />;
}

function MultiEditDiff({ input }: { input: MultiEditInput }) {
	const diffs = useMemo(
		() =>
			input.edits.map((edit, index) => ({
				index,
				patch: createPatch(input.file_path, edit.old_string, edit.new_string),
			})),
		[input.file_path, input.edits],
	);

	return (
		<div className="space-y-2">
			{diffs.map(({ index, patch }) => (
				<DiffViewer key={index} fileName={input.file_path} hunks={[patch]} />
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
						<DiffViewer fileName={change.newPath} hunks={[change.patch]} />
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
			return <EditDiff input={change.input} />;
		case "multiEdit":
			return <MultiEditDiff input={change.input} />;
		case "write":
			return (
				<FileContentDisplay
					content={change.input.content}
					filePath={change.input.file_path}
				/>
			);
		case "codex":
			return <CodexDiff changes={change.changes} />;
	}
}
