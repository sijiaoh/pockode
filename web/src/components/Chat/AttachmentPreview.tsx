import { Download, ExternalLink } from "lucide-react";
import { useAttachmentContent } from "../../hooks/useAttachmentContent";
import { saveBlob } from "../../lib/fileDownload";
import type { AttachmentSource, FileBlock } from "../../types/content";
import { attachmentFileName, attachmentName } from "../../utils/attachment";
import { fileContentToBlob, getFileViewState } from "../../utils/fileView";
import FileBody from "../Files/FileBody";
import { getActionIconButtonClass, Spinner } from "../ui";

interface Props {
	file: FileBlock;
	source: AttachmentSource;
	/** The file in the work directory this came from, if it is one. */
	workspacePath: string | null;
	/** Absent when the host cannot navigate; the entry then offers no way over. */
	onOpenFile?: (path: string) => void;
}

/**
 * An attachment shown at full size, in place, under the strip it was picked
 * from.
 *
 * In place rather than in a full-screen layer: the only container that could
 * hold one is `Sheet`, which is a centred modal at `max-w-md`, and a second
 * viewer written from scratch would repeat its portal, scroll lock, focus trap
 * and Escape handling. Anyone who wants the real thing — zoom, download,
 * delete — has Open in Files, which is that viewer already.
 *
 * `FileBody` does the rendering, so an image, a decode failure and a file too
 * large to send are described here in the same words the Files tab uses.
 */
function AttachmentPreview({ file, source, workspacePath, onOpenFile }: Props) {
	const { data, error } = useAttachmentContent(source);
	const name = attachmentName(file);

	if (error) {
		return (
			<div className="border-t border-th-border p-2 text-th-error">
				Couldn't load {name}.
			</div>
		);
	}
	if (!data) {
		return (
			<div className="flex justify-center border-t border-th-border p-4">
				<Spinner variant="current" className="text-th-text-muted" />
			</div>
		);
	}

	// Reading a field, not the content: the bytes are decoded in the click
	// handler instead. Building the Blob here would turn megabytes of base64
	// into bytes on every render this component has — for a button that is
	// usually never pressed.
	const canSave = data.encoding !== "none";

	return (
		<div className="border-t border-th-border">
			<FileBody
				state={getFileViewState(data)}
				path={name}
				readOnly
				// Dimensions the agent reported, so the frame is the right shape
				// before the bytes decode.
				imageDimensions={
					file.width && file.height
						? { width: file.width, height: file.height }
						: undefined
				}
			/>
			{(canSave || (workspacePath && onOpenFile)) && (
				<div className="flex justify-end gap-2 px-2 pb-2">
					{workspacePath && onOpenFile && (
						<button
							type="button"
							onClick={() => onOpenFile(workspacePath)}
							aria-label="Open in Files"
							title="Open in Files"
							className={getActionIconButtonClass(true)}
						>
							<ExternalLink className="size-4" />
						</button>
					)}
					{canSave && (
						<button
							type="button"
							onClick={() => {
								const blob = fileContentToBlob(data);
								if (blob) saveBlob(blob, attachmentFileName(file));
							}}
							aria-label="Save"
							title="Save"
							className={getActionIconButtonClass(true)}
						>
							<Download className="size-4" />
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export default AttachmentPreview;
