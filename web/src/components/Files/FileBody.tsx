import { Binary, File, FileWarning } from "lucide-react";
import { formatBytes } from "../../utils/bytes";
import { type FileViewState, getMimeType } from "../../utils/fileView";
import { splitPath } from "../../utils/path";
import { FileContentDisplay, FileStateCard } from "../ui";
import ImagePreview from "./ImagePreview";

interface Props {
	state: FileViewState;
	path: string;
}

function fileDetails(mime: string, size: number) {
	return [
		{ label: "Type", value: getMimeType(mime) },
		{ label: "Size", value: formatBytes(size) },
	];
}

function FileBody({ state, path }: Props) {
	switch (state.kind) {
		case "empty":
			// A zero-byte file would otherwise render as blank space that reads as
			// a loading bug.
			return (
				<FileStateCard
					icon={File}
					title="Empty file"
					description="This file has no content."
				/>
			);

		case "text":
			return (
				<>
					{!state.highlight && (
						<div className="border-b border-th-border bg-th-bg-secondary px-4 py-2 text-xs text-th-text-muted">
							Large file — showing plain text only.
						</div>
					)}
					<div className="p-2">
						<FileContentDisplay
							content={state.content}
							filePath={path}
							plain={!state.highlight}
						/>
					</div>
				</>
			);

		case "image":
			return (
				<ImagePreview
					src={state.src}
					fileName={splitPath(path).fileName}
					mime={state.mime}
					size={state.size}
				/>
			);

		case "binary":
			return (
				<FileStateCard
					icon={Binary}
					title="Binary file"
					description="This file can't be previewed."
					details={fileDetails(state.mime, state.size)}
					footnote="Editing is disabled for binary files."
				/>
			);

		case "too-large":
			return (
				<FileStateCard
					icon={FileWarning}
					iconClassName="text-th-warning"
					title={
						getMimeType(state.mime).startsWith("image/")
							? "Image is too large to preview"
							: "File is too large to preview"
					}
					description={
						state.limit === undefined
							? `This file is ${formatBytes(state.size)}.`
							: `This file is ${formatBytes(state.size)}. Files over ${formatBytes(
									state.limit,
								)} aren't loaded to keep the app responsive.`
					}
					details={fileDetails(state.mime, state.size)}
					footnote="Editing is disabled for files this large."
				/>
			);
	}
}

export default FileBody;
