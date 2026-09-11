import { Binary, File, FileWarning } from "lucide-react";
import { formatBytes } from "../../utils/bytes";
import { type FileViewState, getMimeType } from "../../utils/fileView";
import { splitPath } from "../../utils/path";
import { FileContentDisplay, FileStateCard } from "../ui";
import ImagePreview from "./ImagePreview";

interface Props {
	state: FileViewState;
	path: string;
	/**
	 * Offered on the cards that stand in for content, since a file that cannot be
	 * previewed is exactly the one the user needs to open elsewhere — the icon in
	 * the bottom bar is easy to miss when the page says "can't be previewed".
	 *
	 * Omitted only where downloading is not a thing that exists: the endpoint
	 * serves the working tree, so a historical version has nothing to offer.
	 */
	downloadAction?: { label: string; onClick: () => void; disabled?: boolean };
	/**
	 * Render text verbatim: no syntax highlighting, and Markdown as its source.
	 * Large files force it on; a viewer may also offer it, which is the only way
	 * to reach the highlighter's copy button on a Markdown file.
	 */
	plain?: boolean;
	/**
	 * Set where the surrounding screen has no editing at all. The cards below
	 * otherwise explain why editing is disabled, which is written for the
	 * disabled Edit button in the viewer's bottom bar; with no such button on
	 * screen the sentence points at a control that isn't there, and implies a
	 * non-binary file here would be editable.
	 */
	readOnly?: boolean;
}

function fileDetails(mime: string, size: number) {
	return [
		{ label: "Type", value: getMimeType(mime) },
		{ label: "Size", value: formatBytes(size) },
	];
}

function FileBody({ state, path, downloadAction, plain, readOnly }: Props) {
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
					{/* Only the forced case is worth a banner: when the reader asked
					    for plain text themselves, saying so back is noise. */}
					{!state.highlight && (
						<div className="border-b border-th-border bg-th-bg-secondary px-4 py-2 text-xs text-th-text-muted">
							Large file — showing plain text only.
						</div>
					)}
					<div className="p-2">
						<FileContentDisplay
							content={state.content}
							filePath={path}
							plain={!state.highlight || plain}
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
					footnote={
						readOnly ? undefined : "Editing is disabled for binary files."
					}
					action={downloadAction}
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
					footnote={
						readOnly ? undefined : "Editing is disabled for files this large."
					}
					action={downloadAction}
				/>
			);
	}
}

export default FileBody;
