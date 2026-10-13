import { ImageOff } from "lucide-react";
import { formatBytes } from "../../utils/bytes";
import { getMimeType } from "../../utils/fileView";
import { FileStateCard } from "../ui";

interface Props {
	/** Why the bytes could not be read; absent when they were read and would not decode. */
	readError?: Error | null;
	mime: string;
	size: number;
	onRetry: () => void;
}

/**
 * What stands in for an image that could not be shown, said the same way in
 * the in-place preview and the full-screen viewer.
 */
export function ImageFailureCard({ readError, mime, size, onRetry }: Props) {
	return (
		<FileStateCard
			icon={ImageOff}
			iconClassName="text-th-error"
			title={readError ? "Couldn't load image" : "Image can't be displayed"}
			description={
				readError ? readError.message : "The browser couldn't decode this file."
			}
			details={[
				{ label: "Type", value: getMimeType(mime) },
				{ label: "Size", value: formatBytes(size) },
			]}
			action={{ label: "Retry", onClick: onRetry }}
		/>
	);
}
