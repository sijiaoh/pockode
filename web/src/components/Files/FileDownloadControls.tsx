import { ConfirmDialog } from "@pockode/shared";
import { Download, Loader2 } from "lucide-react";
import type { FileDownload } from "../../hooks/useFileDownload";
import { formatBytes } from "../../utils/bytes";
import { getActionIconButtonClass } from "../ui";

interface ButtonProps {
	download: FileDownload;
	disabled?: boolean;
}

/** The bottom bar's Download button, a spinner that cancels while running. */
export function DownloadButton({ download, disabled = false }: ButtonProps) {
	return (
		<button
			type="button"
			onClick={download.toggle}
			disabled={disabled}
			className={getActionIconButtonClass(!disabled)}
			aria-label={download.label}
			title={download.label}
		>
			{download.isDownloading ? (
				<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
			) : (
				<Download className="h-4 w-4" aria-hidden="true" />
			)}
		</button>
	);
}

interface DialogProps {
	download: FileDownload;
	size: number;
}

/** Asks before a download past `LARGE_DOWNLOAD_WARNING_SIZE`. */
export function LargeDownloadDialog({ download, size }: DialogProps) {
	if (!download.confirmingSize) return null;
	return (
		<ConfirmDialog
			title="Download this file?"
			message={`This file is ${formatBytes(size)}. Your browser holds the whole file until the download finishes — you get nothing if it is interrupted.`}
			confirmLabel="Download"
			onConfirm={download.confirmSize}
			onCancel={download.cancelSize}
		/>
	);
}
