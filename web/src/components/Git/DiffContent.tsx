import { memo } from "react";
import type { GitDiffData } from "../../types/git";
import FileBody from "../Files/FileBody";
import { DiffViewer } from "../ui";

interface Props {
	data: GitDiffData;
	fileName: string;
}

const DiffContent = memo(function DiffContent({ data, fileName }: Props) {
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

	if (!diff.trim()) {
		return <div className="p-4 text-center text-th-text-muted">No changes</div>;
	}

	return (
		<DiffViewer
			fileName={fileName}
			hunks={[diff]}
			oldContent={oldContent}
			newContent={newContent}
		/>
	);
});

export default DiffContent;
