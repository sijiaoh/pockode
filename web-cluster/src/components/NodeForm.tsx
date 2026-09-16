import { Sheet, Spinner } from "@pockode/shared";
import { useEffect, useRef, useState } from "react";
import type { Node } from "../types/node";
import { baseName } from "../utils/path";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON } from "./buttons";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (
		path: string,
		name?: string,
		createMissingDir?: boolean,
	) => Promise<void>;
	editingNode?: Node | null;
}

// The backend reports a non-existent directory with this exact substring
// (message: "invalid node: path does not exist"). Every other path error — not
// a directory, permission denied, duplicate — is shown as-is and offers no
// creation, because creating is not what would fix it.
function isPathNotExistError(message: string) {
	return message.toLowerCase().includes("path does not exist");
}

export function NodeForm({ isOpen, onClose, onSubmit, editingNode }: Props) {
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	// The missing-directory question is asked inside the form, not as a dialog
	// over it: the notice appears under the field it is about and the submit
	// button relabels, so the answer is the same press the user was already
	// making. Editing the path withdraws the offer, which keeps "fix the typo"
	// as cheap as "create it".
	const [offerCreateDir, setOfferCreateDir] = useState(false);
	const pathInputRef = useRef<HTMLInputElement>(null);

	const isEditing = !!editingNode;

	useEffect(() => {
		if (isOpen) {
			if (editingNode) {
				setPath(editingNode.path);
				setName(editingNode.name);
			} else {
				setPath("");
				setName("");
			}
			setError(null);
			setOfferCreateDir(false);
			// Straight into the field, not on a timer racing the sheet: `Sheet`
			// takes focus in its own effect, and a child's effect runs before its
			// parent's, so this one — the parent of that sheet — always lands last.
			pathInputRef.current?.focus();
		}
	}, [isOpen, editingNode]);

	const handlePathChange = (value: string) => {
		setPath(value);
		setOfferCreateDir(false);
		setError(null);
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		const trimmed = path.trim();
		if (!trimmed) {
			setError("Path is required");
			return;
		}

		const createMissingDir = offerCreateDir;
		setSaving(true);
		setError(null);

		try {
			await onSubmit(trimmed, name.trim() || undefined, createMissingDir);
			onClose();
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to save node";
			// Only offer once: if creation itself failed, saying "it will be
			// created" a second time would be a loop, so the real message wins.
			if (!createMissingDir && isPathNotExistError(message)) {
				setOfferCreateDir(true);
				return;
			}
			setOfferCreateDir(false);
			setError(message);
		} finally {
			setSaving(false);
		}
	};

	const namePlaceholder = baseName(path.trim()) || "Derived from path";

	const submitLabel = offerCreateDir
		? isEditing
			? "Create & Save"
			: "Create & Add"
		: isEditing
			? "Save"
			: "Add Node";

	if (!isOpen) return null;

	return (
		<Sheet
			title={isEditing ? "Edit Node" : "Add Node"}
			onClose={onClose}
			dismissible={!saving}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						disabled={saving}
						className={`${NEUTRAL_BUTTON} flex-1`}
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={saving || !path.trim()}
						className={`${PRIMARY_BUTTON} flex-1`}
					>
						{saving && <Spinner />}
						{saving ? "Saving..." : submitLabel}
					</button>
				</>
			}
		>
			<div className="flex flex-col gap-4 p-4">
				<div>
					<label
						htmlFor="node-path"
						className="mb-1 block text-sm text-th-text-secondary"
					>
						Project Path <span className="text-th-error">*</span>
					</label>
					<input
						ref={pathInputRef}
						id="node-path"
						type="text"
						value={path}
						onChange={(e) => handlePathChange(e.target.value)}
						// The backend expands `~`, and on a phone the tilde form is a
						// third of the typing an absolute home path would be.
						placeholder="~/projects/my-app"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 font-mono text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
						disabled={saving}
					/>
					{offerCreateDir && (
						<output className="mt-2 block rounded-lg border border-th-border bg-th-bg-tertiary px-3 py-2 text-sm text-th-text-secondary">
							<span className="font-mono">{path.trim()}</span> doesn’t exist
							yet. It will be created.
						</output>
					)}
				</div>

				<div>
					<label
						htmlFor="node-name"
						className="mb-1 block text-sm text-th-text-secondary"
					>
						Display Name
					</label>
					<input
						id="node-name"
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={namePlaceholder}
						className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
						disabled={saving}
					/>
					<p className="mt-1 text-xs text-th-text-muted">
						Leave empty to use the directory name
					</p>
				</div>

				{error && (
					<p className="text-sm text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}
