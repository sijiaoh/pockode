import { Spinner } from "@pockode/shared";
import { CircleAlert, FileText, X } from "lucide-react";
import { useState } from "react";
import type { DraftAttachment } from "../../lib/inputStore";
import { formatBytes } from "../../utils/bytes";

interface Props {
	items: DraftAttachment[];
	onRemove: (key: string) => void;
}

/**
 * The files picked for the next message, above the draft.
 *
 * A failure is drawn as a chip whatever the file was, image or not: the reason
 * is the thing to read, and a thumbnail has no room for it. Send stays off
 * until the file is removed, so a picked file is never quietly left out.
 */
function ComposerAttachments({ items, onRemove }: Props) {
	return (
		// The remove button sits 4px inside each entry's corner, and its 44px
		// hit area reaches 12px past its 20px box — 8px past the entry, which is
		// the top and right padding. Any less and the scrolling box, which
		// clips on both axes, cuts the hit area and scrolls to show the rest.
		<ul
			aria-label="Attachments"
			className="flex gap-2 overflow-x-auto pt-2 pr-2 pb-2"
		>
			{items.map((item) => (
				<li key={item.key} className="relative shrink-0">
					<Entry item={item} />
					<button
						type="button"
						onClick={() => onRemove(item.key)}
						aria-label={`Remove ${item.name}`}
						className="touch-target absolute top-1 right-1 flex size-5 items-center justify-center rounded-full border border-th-border bg-th-bg-primary text-th-text-secondary hover:text-th-text-primary"
					>
						<X className="size-3" aria-hidden="true" />
					</button>
				</li>
			))}
		</ul>
	);
}

function Entry({ item }: { item: DraftAttachment }) {
	// A type the browser cannot draw (HEIC outside Safari) falls back to a chip.
	const [undrawable, setUndrawable] = useState(false);
	const uploading = item.status === "uploading";

	if (item.status === "failed") {
		const reason = item.error ?? "Upload failed";
		return (
			<div
				title={`${item.name}: ${reason}`}
				className="flex h-14 w-48 items-center gap-2 rounded-md border border-th-error bg-th-bg-secondary pr-7 pl-2"
			>
				<CircleAlert
					className="size-5 shrink-0 text-th-error"
					aria-hidden="true"
				/>
				<div className="min-w-0 text-sm">
					<div className="truncate text-th-text-primary">{item.name}</div>
					{/* Said aloud too: the spinner's status goes quietly, and Send
					    turns off with nothing else to say why. */}
					<div role="alert" className="truncate text-xs text-th-error">
						{reason}
					</div>
				</div>
			</div>
		);
	}

	const spinner = uploading && (
		<div className="absolute inset-0 flex items-center justify-center rounded-md bg-th-bg-primary/60">
			<Spinner srText={`Uploading ${item.name}`} />
		</div>
	);

	if (item.previewUrl && !undrawable) {
		return (
			<div className="relative size-14 overflow-hidden rounded-md border border-th-border bg-th-bg-secondary">
				<img
					src={item.previewUrl}
					alt={item.name}
					title={item.name}
					onError={() => setUndrawable(true)}
					className="size-full object-cover"
				/>
				{spinner}
			</div>
		);
	}

	return (
		<div
			title={item.name}
			className="relative flex h-14 items-center gap-2 rounded-md border border-th-border bg-th-bg-secondary pr-7 pl-2"
		>
			<FileText
				className="size-5 shrink-0 text-th-text-muted"
				aria-hidden="true"
			/>
			<div className="text-sm">
				<div className="max-w-40 truncate text-th-text-primary">
					{item.name}
				</div>
				<div className="text-xs text-th-text-muted">
					{formatBytes(item.size)}
				</div>
			</div>
			{spinner}
		</div>
	);
}

export default ComposerAttachments;
