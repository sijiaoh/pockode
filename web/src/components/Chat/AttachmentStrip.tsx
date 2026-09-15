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
	workspacePath,
} from "../../utils/attachment";
import AttachmentChip from "./AttachmentChip";
import AttachmentPreview from "./AttachmentPreview";
import AttachmentThumb from "./AttachmentThumb";

interface Props {
	files: FileBlock[];
	/** The session whose attachment store holds inline content. */
	sessionId: string;
	/** Absent when the host cannot navigate to a file. */
	onOpenFile?: (path: string) => void;
}

/**
 * The files a tool call produced, shown under its header line.
 *
 * Outside the collapsible body on purpose: when a tool answers with a
 * screenshot, the screenshot *is* the answer, and an answer folded behind a
 * chevron has not been shown. The body keeps the prose.
 */
function AttachmentStrip({ files, sessionId, onOpenFile }: Props) {
	const workDir = useWSStore((state) => state.workDir);
	// One at a time: two images open at full size in a chat bubble push
	// everything else off the screen, and picking a second is a clear signal the
	// first is done with.
	const [expanded, setExpanded] = useState<number | null>(null);

	const entries = files.map((file) => ({
		file,
		source: attachmentSource(file, sessionId, workDir),
		path: workspacePath(file, workDir),
	}));
	const open = expanded === null ? null : entries[expanded];

	return (
		<div className="border-t border-th-border">
			<div className="flex items-start gap-2 overflow-x-auto p-2">
				{entries.map(({ file, source, path }, index) => {
					const key = `${file.attachment_id ?? file.path ?? file.mime}-${index}`;
					const name = attachmentName(file);

					if (source && isImageBlock(file)) {
						return (
							<AttachmentThumb
								key={key}
								file={file}
								source={source}
								expanded={expanded === index}
								onToggle={() =>
									setExpanded((current) => (current === index ? null : index))
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
			{open?.source && (
				<AttachmentPreview
					file={open.file}
					source={open.source}
					workspacePath={open.path}
					onOpenFile={onOpenFile}
				/>
			)}
		</div>
	);
}

export default AttachmentStrip;
