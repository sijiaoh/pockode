import { Download, Loader2 } from "lucide-react";
import type { FileDownload } from "../../hooks/useFileDownload";
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
