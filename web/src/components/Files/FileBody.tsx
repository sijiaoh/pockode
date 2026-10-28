import { Binary, File, FileQuestion, FileWarning } from "lucide-react";
import { formatBytes } from "../../utils/bytes";
import {
	type FileViewState,
	getMimeType,
	isImageMime,
} from "../../utils/fileView";
import { splitPath } from "../../utils/path";
import { FileContentDisplay, FileStateCard } from "../ui";
import ImagePreview from "./ImagePreview";
import MediaPreview from "./MediaPreview";
import PagePreview from "./PagePreview";

interface Props {
	state: FileViewState;
	path: string;
	/**
	 * Offered on the cards that stand in for content, since a file that cannot be
	 * previewed is exactly the one the user needs to open elsewhere — the icon in
	 * the bottom bar is easy to miss when the page says "can't be previewed".
	 *
	 * Omitted on a diff, which has no single file to offer.
	 */
	downloadAction?: { label: string; onClick: () => void; disabled?: boolean };
	/**
	 * Drop the rendering to source. For text: no syntax highlighting, and
	 * Markdown as its source — large files force it on, and a viewer may also
	 * offer it, which is the only way to reach the highlighter's copy button on
	 * a Markdown file. For a page: its source, highlighted, instead of the page.
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
	/**
	 * What the image will turn out to be, where something knows before it
	 * decodes — an agent's content block reports it. See `ImagePreview`.
	 */
	imageDimensions?: { width: number; height: number };
	/** Offered by a rendered `.md` file's images; takes a work-directory-relative path. */
	onOpenFile?: (path: string) => void;
}

/** Said where a file's size, not the reader, turned its colours off. */
export function PlainTextNotice() {
	return (
		<div className="shrink-0 border-b border-th-border bg-th-bg-secondary px-4 py-2 text-xs text-th-text-muted">
			Large file — showing plain text only.
		</div>
	);
}

function fileDetails(mime: string, size: number) {
	return [
		{ label: "Type", value: getMimeType(mime) },
		{ label: "Size", value: formatBytes(size) },
	];
}

function FileBody({
	state,
	path,
	downloadAction,
	plain,
	readOnly,
	imageDimensions,
	onOpenFile,
}: Props) {
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
					{!state.highlight && <PlainTextNotice />}
					<div className="p-2">
						<FileContentDisplay
							content={state.content}
							filePath={path}
							plain={!state.highlight || plain}
							onOpenFile={onOpenFile}
						/>
					</div>
				</>
			);

		case "page":
			return plain ? (
				<FileBody
					state={state.source}
					path={path}
					downloadAction={downloadAction}
					readOnly={readOnly}
				/>
			) : (
				<PagePreview
					origin={state.origin}
					fileName={splitPath(path).fileName}
					mime={state.mime}
					size={state.size}
					// What a rewrite changes. A commit never changes, so its page is
					// never reloaded by this.
					revision={
						state.source.kind === "text"
							? state.source.content
							: state.source.size
					}
				/>
			);

		case "image":
			return (
				<ImagePreview
					source={state.source}
					fileName={splitPath(path).fileName}
					mime={state.mime}
					size={state.size}
					dimensions={imageDimensions}
				/>
			);

		case "audio":
		case "video":
			return (
				<MediaPreview
					kind={state.kind}
					origin={state.origin}
					fileName={splitPath(path).fileName}
					mime={state.mime}
					size={state.size}
					downloadAction={downloadAction}
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

		case "unavailable":
			// Not a refusal like the two above: the content was fine, it is just
			// gone — an attachment cleaned up with its session, a file deleted
			// since. Nothing about it is worth explaining as a limitation.
			return (
				<FileStateCard
					icon={FileQuestion}
					title="File not found"
					description="This file is no longer available."
				/>
			);

		case "too-large":
			return (
				<FileStateCard
					icon={FileWarning}
					iconClassName="text-th-warning"
					title={
						isImageMime(state.mime)
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
