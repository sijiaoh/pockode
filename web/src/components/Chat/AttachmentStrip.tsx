import { FileText, ImageOff } from "lucide-react";
import { useState } from "react";
import { useWSStore } from "../../lib/wsStore";
import type { FileBlock } from "../../types/content";
import {
	attachmentDetail,
	attachmentName,
	attachmentSource,
	isImageBlock,
	omittedLabel,
	previewsAsImage,
	workspacePath,
} from "../../utils/attachment";
import { type ImageMediaItem, MediaViewer } from "../Media";
import AttachmentChip from "../ui/AttachmentChip";
import AttachmentThumb from "./AttachmentThumb";

interface Props {
	files: FileBlock[];
	/** The session whose attachment store holds inline content. */
	sessionId: string;
	/** Absent when the host cannot navigate to a file. */
	onOpenFile?: (path: string) => void;
	/**
	 * Draws the rule that sets the strip off from the header line above it. Off
	 * in a user bubble, where what is above is the message's own text.
	 */
	divided?: boolean;
}

/**
 * The files a tool call produced, shown under its header line.
 *
 * Outside the collapsible body on purpose: when a tool answers with a
 * screenshot, the screenshot *is* the answer, and an answer folded behind a
 * chevron has not been shown. The body keeps the prose.
 *
 * Which is also what decides what may be put here. A block marked `not_fetched`
 * is not an answer — nobody read it — so it never reaches this strip; it is
 * drawn beside the result as a reference line instead. `partitionFileBlocks`
 * (`lib/contentBlocks.ts`) is where that split is made, and it is the one to
 * extend rather than adding a second weight of entry to this row.
 */
function AttachmentStrip({
	files,
	sessionId,
	onOpenFile,
	divided = true,
}: Props) {
	const workDir = useWSStore((state) => state.workDir);
	// Held here rather than by the thumbnail, so a thumbnail that changes state
	// underneath (a read retried, a decode failing) does not take the viewer with
	// it. The strip sits inside the transcript's `CoveredSurface`, which is what
	// closes the viewer when the chat is covered.
	const [viewing, setViewing] = useState<{
		item: ImageMediaItem;
		openInFiles?: () => void;
	} | null>(null);

	const entries = files.map((file) => ({
		file,
		source: attachmentSource(file, sessionId, workDir),
		path: workspacePath(file, workDir),
	}));

	return (
		<div className={divided ? "border-t border-th-border" : undefined}>
			<div className="flex items-start gap-2 overflow-x-auto p-2">
				{entries.map(({ file, source, path }, index) => {
					const key = `${file.attachment_id ?? file.path ?? file.mime}-${index}`;
					const name = attachmentName(file);

					if (source && previewsAsImage(file)) {
						return (
							<AttachmentThumb
								key={key}
								file={file}
								source={source}
								onOpen={(item) =>
									setViewing({
										item,
										openInFiles:
											path && onOpenFile ? () => onOpenFile(path) : undefined,
									})
								}
							/>
						);
					}

					const reason = omittedLabel(file);
					return (
						<AttachmentChip
							key={key}
							// An image with nothing behind it is the one case worth its own
							// icon: the reader is looking for a picture and will not find
							// one, and a generic file glyph would not say that.
							icon={isImageBlock(file) ? ImageOff : FileText}
							title={name}
							tooltip={file.path}
							// The reason wins over the description: a reader looking at an
							// entry with nothing behind it needs to know why first.
							detail={reason ?? attachmentDetail(file)}
							action={
								path && onOpenFile
									? { label: "Open", onClick: () => onOpenFile(path) }
									: undefined
							}
						/>
					);
				})}
			</div>
			{viewing && (
				<MediaViewer
					item={viewing.item}
					openInFiles={viewing.openInFiles}
					onClose={() => setViewing(null)}
				/>
			)}
		</div>
	);
}

export default AttachmentStrip;
