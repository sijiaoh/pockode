import { Upload } from "lucide-react";
import { type ChangeEvent, useRef } from "react";

interface Props {
	/** Destination directory; empty is the workspace root. */
	destPath: string;
	onFiles: (files: File[]) => void;
}

/**
 * Opens a file picker.
 *
 * Icon-only and monochrome because uploading happens a few times a week, next
 * to a tree the user touches constantly; the destination is shown by the accent
 * bar on the folder row instead, and the dot here only says "not the root", so
 * the user knows to look for it. It is still the only upload entry point a
 * touch screen has — drag and drop does not exist there — and the only one a
 * keyboard or screen reader can use anywhere, which is why the whole path lives
 * in the accessible name.
 */
function UploadButton({ destPath, onFiles }: Props) {
	const inputRef = useRef<HTMLInputElement>(null);

	const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		// Cleared so that picking the same file twice in a row still fires.
		event.target.value = "";
		if (files.length > 0) onFiles(files);
	};

	const label = destPath ? `Upload to ${destPath}` : "Upload to project root";

	return (
		<>
			<input
				ref={inputRef}
				type="file"
				multiple
				onChange={handleChange}
				className="hidden"
				tabIndex={-1}
				aria-hidden="true"
			/>
			<button
				type="button"
				onClick={() => inputRef.current?.click()}
				aria-label={label}
				title={label}
				className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-th-text-muted transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95"
			>
				<Upload className="h-4 w-4 shrink-0" aria-hidden="true" />
				{destPath && (
					<span
						className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-th-accent"
						aria-hidden="true"
					/>
				)}
			</button>
		</>
	);
}

export default UploadButton;
