import { memo, type ReactNode } from "react";
import type { DiffHunk } from "../../lib/diffHunks";
import type { LinePress, LineView } from "../../lib/diffRows";
import { useDiffSettings, useGitDiffWrap } from "../../lib/diffSettingsStore";
import type { GitDiffData } from "../../types/git";
import FileBody from "../Files/FileBody";
import { DiffViewer } from "../ui";

interface Props {
	data: GitDiffData;
	fileName: string;
	/**
	 * Side by side. The caller's to decide: the review offers it, a commit's
	 * file diff does not.
	 */
	split?: boolean;
	/** A title row for each hunk; see DiffViewer. */
	renderHunkBar?: (hunk: DiffHunk, index: number) => ReactNode;
	/** Line selection by the gutter; see DiffViewer. */
	onLinePress?: (press: LinePress) => void;
	selectedLines?: { view: LineView; keys: ReadonlySet<string> } | null;
}

const DiffContent = memo(function DiffContent({
	data,
	fileName,
	split,
	renderHunkBar,
	onLinePress,
	selectedLines,
}: Props) {
	const { wrap } = useGitDiffWrap();
	const { hideWhitespace, setHideWhitespace } = useDiffSettings();

	// Withheld for the reason file.get withholds a file, so it reads the same as
	// opening that file would. Read-only: a diff has no Edit button to explain.
	if (data.omitted) {
		return (
			<FileBody
				state={{
					kind: "too-large",
					mime: data.mime,
					size: data.size,
					limit: data.limit,
				}}
				path={fileName}
				readOnly
			/>
		);
	}

	const { diff, old_content: oldContent, new_content: newContent } = data;
	if (/^Binary files .+ and .+ differ$/m.test(diff)) {
		return (
			<div className="p-4 text-center text-th-text-muted">
				Binary file - cannot display diff
			</div>
		);
	}

	// No hunk: git prints only headers for a mode change, a rename with no
	// edit, or an empty file added or removed — or nothing at all.
	if (!/^@@ /m.test(diff)) {
		// Hidden whitespace is the one way an empty diff can stand for a file
		// whose content did change; a bare "No changes" there reads as a bug.
		if (hideWhitespace && oldContent !== newContent) {
			return (
				<div className="flex flex-col items-center gap-1 p-4 text-center text-th-text-muted">
					<p>Only whitespace changed</p>
					<button
						type="button"
						onClick={() => setHideWhitespace(false)}
						className="inline-flex min-h-9 items-center rounded px-2 text-sm text-th-accent hover:underline pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						Show whitespace
					</button>
				</div>
			);
		}
		return (
			<div className="p-4 text-center text-th-text-muted">
				No content changes
			</div>
		);
	}

	return (
		<DiffViewer
			fileName={fileName}
			hunks={[diff]}
			oldContent={oldContent}
			newContent={newContent}
			wrap={wrap}
			split={split}
			renderHunkBar={renderHunkBar}
			onLinePress={onLinePress}
			selectedLines={selectedLines}
		/>
	);
});

export default DiffContent;
