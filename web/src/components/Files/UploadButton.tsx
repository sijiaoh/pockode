import { Upload } from "lucide-react";
import { type ChangeEvent, useRef } from "react";

interface Props {
	/** Destination directory; empty is the workspace root. */
	destPath: string;
	onFiles: (files: File[]) => void;
}

/**
 * Opens a file picker, and shows where what it picks will land.
 *
 * The button doubles as the destination indicator so the Files tab does not
 * grow a second row for it. It is also the only upload entry point a touch
 * screen has — drag and drop does not exist there — and the only one a keyboard
 * or screen reader can use anywhere.
 */
function UploadButton({ destPath, onFiles }: Props) {
	const inputRef = useRef<HTMLInputElement>(null);

	const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		// Cleared so that picking the same file twice in a row still fires.
		event.target.value = "";
		if (files.length > 0) onFiles(files);
	};

	const folderName = destPath.slice(destPath.lastIndexOf("/") + 1);
	// The visible name is truncated, so the accessible one carries the whole path.
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
				className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95 ${
					destPath
						? "border-th-accent bg-th-accent/10 text-th-accent"
						: "border-th-border text-th-text-secondary hover:text-th-text-primary"
				}`}
			>
				<Upload className="h-4 w-4 shrink-0" aria-hidden="true" />
				{folderName && (
					<span className="max-w-[7rem] truncate">{folderName}</span>
				)}
			</button>
		</>
	);
}

export default UploadButton;
