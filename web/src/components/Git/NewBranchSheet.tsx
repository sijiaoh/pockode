import { useEffect, useId, useRef, useState } from "react";
import { gitBusySummary } from "../../utils/gitErrors";
import { Sheet, Spinner } from "../ui";
import { inputClass } from "../ui/inputClass";

interface Props {
	/** What the new branch forks from, already rendered for display. */
	base: string;
	onClose: () => void;
	onCreate: (name: string) => Promise<void>;
}

function NewBranchSheet({ base, onClose, onCreate }: Props) {
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || isCreating) return;

		setError(null);
		setIsCreating(true);
		try {
			await onCreate(trimmed);
		} catch (err) {
			// git's refusal is the message here — it names the rule the name broke
			// — but a busy worktree is the server's own sentence, not git's.
			setError(
				gitBusySummary(err) ??
					(err instanceof Error ? err.message : String(err)),
			);
		} finally {
			setIsCreating(false);
		}
	};

	return (
		<Sheet
			title="New branch"
			onClose={onClose}
			dismissible={!isCreating}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						disabled={isCreating}
						className="flex-1 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!name.trim() || isCreating}
						className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
					>
						{/* The gerund label already announces the state; the spinner's
						    own "Loading" would only say it twice. */}
						{isCreating && <Spinner variant="current" srText={null} />}
						{isCreating ? "Creating…" : "Create"}
					</button>
				</>
			}
		>
			<div className="space-y-4 p-4">
				{/* Above the field, like the panel's other sheets: pushed below it the
				    refusal would sit under the on-screen keyboard on a phone. */}
				{error && (
					<p className="whitespace-pre-wrap text-sm text-th-error" role="alert">
						{error}
					</p>
				)}

				<div className="space-y-1.5">
					<label htmlFor={inputId} className="text-sm text-th-text-primary">
						Name
					</label>
					<input
						ref={inputRef}
						id={inputId}
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="feature/my-feature"
						className={`w-full rounded-lg bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
						disabled={isCreating}
						autoComplete="off"
						required
					/>
					<p className="text-xs text-th-text-muted">Branches from {base}</p>
				</div>

				<p className="rounded-lg bg-th-bg-tertiary px-3 py-2 text-sm text-th-text-secondary">
					Uncommitted changes come with you to the new branch.
				</p>
			</div>
		</Sheet>
	);
}

export default NewBranchSheet;
