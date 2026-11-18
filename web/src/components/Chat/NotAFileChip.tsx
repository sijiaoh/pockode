import { Folder, Link2 } from "lucide-react";
import type { NotAFile } from "../../hooks/useAttachmentContent";
import AttachmentChip from "../ui/AttachmentChip";

interface Props {
	name: string;
	notAFile: NotAFile;
	/** Absent where the strip has no Files to open it in. */
	onOpenInFiles?: () => void;
}

/**
 * A strip entry whose path turned out to be a folder or a link that cannot be
 * followed. It is not content the strip can draw, but it is somewhere the
 * viewer can show, so the chip opens it there (docs/symlinks.md#chat).
 */
function NotAFileChip({ name, notAFile, onOpenInFiles }: Props) {
	return (
		<AttachmentChip
			icon={notAFile === "folder" ? Folder : Link2}
			title={name}
			detail={notAFile === "folder" ? "Folder" : "Link"}
			action={
				onOpenInFiles
					? {
							label: "Open",
							ariaLabel: `Open ${name} in Files`,
							onClick: onOpenInFiles,
						}
					: undefined
			}
		/>
	);
}

export default NotAFileChip;
