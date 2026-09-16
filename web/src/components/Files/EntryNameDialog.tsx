import { useEffect, useId, useRef, useState } from "react";
import type { EntryType } from "../../types/contents";
import { Sheet, Spinner } from "../ui";

interface Props {
	mode: "create" | "rename";
	type: EntryType;
	/** Directory the entry lives in; empty is the workspace root. */
	dir: string;
	/** The name being changed, for `rename`; the field starts empty without it. */
	currentName?: string;
	/**
	 * Names already spoken for in `dir`, or null while its listing is still on
	 * its way. Null disables the button rather than letting a name through
	 * unchecked, so the immediate answer is either right or not yet given.
	 *
	 * `currentName` may be in here — the entry being renamed is in its own
	 * directory's listing. It is answered as "unchanged" before the set is
	 * consulted, so it never reads as taken.
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
 * Where the pre-selection stops, so the name can be replaced without also
 * retyping the extension.
 *
 * Renaming is almost always about the name and not the type. A folder, and a
 * file with no extension to protect, are selected whole; so is a dotfile, where
 * the leading dot is part of the name rather than a suffix on one
 * (`.gitignore`, not `gitignore` of type `ignore`).
 */
function stemLength(name: string, type: EntryType): number {
	if (type === "dir") return name.length;
	const lastDot = name.lastIndexOf(".");
	return lastDot > 0 ? lastDot : name.length;
}

/**
 * Names a file or folder, whether it is about to exist or already does.
 *
 * A sheet rather than an inline row in the tree: an inline row means a ghost
 * entry threaded through the recursive tree, its own indentation and
 * scroll-into-view handling, and on a phone the on-screen keyboard tends to
 * come up over exactly the row being typed into.
 *
 * Creating and renaming share it because they ask for the same thing under the
 * same rules. Two components would mean two answers to "is this name legal
 * here", and the one the user meets second would be the one that is wrong.
 */
function EntryNameDialog({
	mode,
	type,
	dir,
	currentName,
	takenNames,
	submitting,
	serverError,
	onCancel,
	onSubmit,
}: Props) {
	const isRename = mode === "rename";
	const [name, setName] = useState(isRename ? (currentName ?? "") : "");
	// The name the server's refusal was about, so editing the name retires it.
	const [submittedName, setSubmittedName] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const errorId = useId();

	// Once, on open: a sheet is mounted for one entry and unmounted when it is
	// done with, so none of what this reads can change underneath it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: opening the sheet is the trigger, not any later change to these
	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		input.focus();
		if (isRename && currentName) {
			input.setSelectionRange(0, stemLength(currentName, type));
		}
	}, []);

	const trimmed = name.trim();
	// Not an error: a name that has not been touched yet is the normal state of
	// this sheet, and saying "the name is unchanged" would only scold the user
	// for having opened it.
	const unchanged = isRename && trimmed === currentName;
	const localError =
		trimmed && !unchanged ? nameError(trimmed, takenNames) : null;
	const error =
		localError ?? (submittedName === trimmed ? serverError : null) ?? null;
	// A listing still arriving is not a name that is wrong, so it holds the
	// button without putting a message under the field.
	const canSubmit =
		trimmed !== "" &&
		!unchanged &&
		!localError &&
		takenNames !== null &&
		!submitting;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!canSubmit) return;
		setSubmittedName(trimmed);
		onSubmit(trimmed);
	};

	const isFile = type === "file";
	const title = isRename
		? isFile
			? "Rename file"
			: "Rename folder"
		: isFile
			? "New file"
			: "New folder";
	const submitLabel = isRename
		? submitting
			? "Renaming…"
			: "Rename"
		: submitting
			? "Creating…"
			: "Create";

	return (
		<Sheet
			title={title}
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
						{submitLabel}
					</button>
				</>
			}
		>
			<div className="space-y-1.5 p-4">
				{/* `Sheet` has no room for a subtitle, and adding one for a single
				    caller would put a slot on every sheet in the app. Kept for
				    renaming too, where it says the entry is not going anywhere. */}
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

export default EntryNameDialog;
