import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface Props {
	/** Names that already exist in the destination. */
	names: string[];
	/** Total files in the batch, so the count reads as "3 of 5". */
	total: number;
	/** Destination directory; empty is the workspace root. */
	destPath: string;
	onKeepBoth: () => void;
	onReplace: () => void;
	onSkip: () => void;
}

/**
 * Asks once, before anything is sent, what to do about names already taken.
 *
 * Built on `ConfirmDialog`'s shell rather than that component: it is a
 * two-answer dialog, and a third button would change the shape of an API two
 * projects share. If a third three-way choice ever appears, that is the moment
 * to extract the shell itself.
 */
function UploadConflictDialog({
	names,
	total,
	destPath,
	onKeepBoth,
	onReplace,
	onSkip,
}: Props) {
	const keepBothRef = useRef<HTMLButtonElement>(null);
	const titleId = useId();

	// Escape has to reach the latest `onSkip` without the effect depending on it:
	// the callers pass a new closure every render, and re-running the effect
	// would pull focus back to Keep both each time — an upload finishing
	// elsewhere in the tab would drag it out from under a user tabbing to
	// Replace.
	const skipRef = useRef(onSkip);
	skipRef.current = onSkip;

	useEffect(() => {
		// "Keep both" is the default answer for the same reason it is the primary
		// button: this is a code workspace, and a stray copy costs less than a
		// source file replaced without being read.
		keepBothRef.current?.focus();

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				skipRef.current();
			}
		};

		const originalOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";

		// Capture phase, and this is what makes the `stopPropagation` above mean
		// something: the sidebar closes itself on Escape from a listener of its
		// own on `document` (`Sidebar.tsx`), which a bubble-phase listener on the
		// same node cannot head off. Answering the dialog should not also close
		// the panel it was asked from.
		document.addEventListener("keydown", handleKeyDown, true);
		return () => {
			document.removeEventListener("keydown", handleKeyDown, true);
			document.body.style.overflow = originalOverflow;
		};
	}, []);

	const stopEvent = (e: React.SyntheticEvent) => e.stopPropagation();
	const destination = destPath || "the project root";
	// One entry per name: two files cannot share one in a directory, and a
	// repeat here would be both a confusing list and a duplicate React key.
	const listed = [...new Set(names)];

	return createPortal(
		/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled in useEffect */
		<div
			className="fixed inset-0 z-[70] flex items-center justify-center bg-th-bg-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onClick={stopEvent}
			onMouseDown={stopEvent}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: backdrop */}
			<div className="absolute inset-0 z-0" onClick={onSkip} />
			<div className="relative z-10 mx-4 w-full max-w-sm rounded-lg bg-th-bg-secondary p-4 shadow-xl">
				<h2 id={titleId} className="text-lg font-bold text-th-text-primary">
					Files already exist
				</h2>
				<p className="mt-2 text-sm text-th-text-muted">
					{names.length} of {total} {total === 1 ? "file" : "files"} already
					{names.length === 1 ? " exists" : " exist"} in {destination}:
				</p>
				<ul className="mt-2 max-h-40 overflow-auto rounded-lg border border-th-border px-3 py-2 text-sm text-th-text-secondary">
					{listed.map((name) => (
						<li key={name} className="truncate py-0.5">
							{name}
						</li>
					))}
				</ul>

				<div className="mt-4 flex flex-wrap justify-end gap-2">
					<button
						type="button"
						onClick={onSkip}
						className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm text-th-text-primary transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						Skip
					</button>
					<button
						type="button"
						onClick={onReplace}
						className="rounded-lg border border-th-error px-4 py-2 text-sm text-th-error transition-colors hover:bg-th-error/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						Replace
					</button>
					<button
						ref={keepBothRef}
						type="button"
						onClick={onKeepBoth}
						className="rounded-lg bg-th-accent px-4 py-2 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						Keep both
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

export default UploadConflictDialog;
