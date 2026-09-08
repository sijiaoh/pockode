import { useEffect, useId, useRef, useState } from "react";
import type { EntryType } from "../../types/contents";
import { Sheet, Spinner } from "../ui";

interface Props {
	type: EntryType;
	/** Directory the entry is created in; empty is the workspace root. */
	dir: string;
	/**
	 * Names already spoken for in `dir`, or null while its listing is still on
	 * its way. Null disables the button rather than letting a name through
	 * unchecked, so the immediate answer is either right or not yet given.
	 */
	takenNames: Set<string> | null;
	submitting: boolean;
	/** The server's refusal of the name last submitted, if it refused one. */
	serverError: string | null;
	onCancel: () => void;
	onSubmit: (name: string) => void;
}

/** Why this name cannot be used, as far as the client can tell. */
function nameError(
	name: string,
	takenNames: Set<string> | null,
): string | null {
	if (name.includes("/")) return "A name cannot contain “/”.";
	if (name === "." || name === "..") return "That name is reserved.";
	if (takenNames?.has(name)) return `“${name}” already exists here.`;
	return null;
}

/**
 * Names a new file or folder.
 *
 * A sheet rather than an inline row in the tree: an inline row means a ghost
 * entry threaded through the recursive tree, its own indentation and
 * scroll-into-view handling, and on a phone the on-screen keyboard tends to
 * come up over exactly the row being typed into.
 */
function NewEntryDialog({
	type,
	dir,
	takenNames,
	submitting,
	serverError,
	onCancel,
	onSubmit,
}: Props) {
	const [name, setName] = useState("");
	// The name the server's refusal was about, so editing the name retires it.
	const [submittedName, setSubmittedName] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const errorId = useId();

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const trimmed = name.trim();
	const localError = trimmed ? nameError(trimmed, takenNames) : null;
	const error =
		localError ?? (submittedName === trimmed ? serverError : null) ?? null;
	// A listing still arriving is not a name that is wrong, so it holds the
	// button without putting a message under the field.
	const canSubmit =
		trimmed !== "" && !localError && takenNames !== null && !submitting;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSubmit) return;
		setSubmittedName(trimmed);
		onSubmit(trimmed);
	};

	const isFile = type === "file";

	return (
		<Sheet
			title={isFile ? "New file" : "New folder"}
			onClose={onCancel}
			dismissible={!submitting}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onCancel}
						disabled={submitting}
						className="flex-1 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!canSubmit}
						className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
					>
						{/* Also while the listing loads: the button is held for a reason
						    the user cannot see, and this is the only sign of it. */}
						{(submitting || takenNames === null) && (
							<Spinner variant="current" srText={null} />
						)}
						{submitting ? "Creating…" : "Create"}
					</button>
				</>
			}
		>
			<div className="space-y-1.5 p-4">
				{/* `Sheet` has no room for a subtitle, and adding one for a single
				    caller would put a slot on every sheet in the app. */}
				<p className="text-xs text-th-text-muted">in {dir || "project root"}</p>
				<label htmlFor={inputId} className="text-sm text-th-text-primary">
					Name
				</label>
				<input
					ref={inputRef}
					id={inputId}
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder={isFile ? "notes.md" : "utils"}
					disabled={submitting}
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					aria-invalid={error !== null}
					aria-describedby={error ? errorId : undefined}
					className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
				/>
				{/* Under the field, where the name being corrected is: a refusal
				    pushed above it reads as being about the sheet, not the name. */}
				{error && (
					<p id={errorId} className="text-sm text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}

export default NewEntryDialog;
