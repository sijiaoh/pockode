import type { FileStatus } from "../../types/git";
import DiffFileItem from "./DiffFileItem";

interface Props {
	title: string;
	files: FileStatus[];
	staged: boolean;
	onSelectFile: (path: string, staged: boolean) => void;
	activeFile: { path: string; staged: boolean } | null;
}

function DiffFileList({
	title,
	files,
	staged,
	onSelectFile,
	activeFile,
}: Props) {
	if (files.length === 0) {
		return null;
	}

	return (
		<div className="flex flex-col">
			<div className="px-3 py-2 text-xs font-semibold uppercase text-th-text-muted">
				{title} ({files.length})
			</div>
			<div className="flex flex-col gap-1 px-2">
				{files.map((file) => (
					<DiffFileItem
						key={`${staged}-${file.path}`}
						file={file}
						onSelect={() => onSelectFile(file.path, staged)}
						isActive={
							activeFile?.staged === staged && activeFile?.path === file.path
						}
					/>
				))}
			</div>
		</div>
	);
}

export default DiffFileList;
