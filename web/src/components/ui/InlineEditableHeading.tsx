import { Check, Loader2, Pencil, X } from "lucide-react";
import { useInlineEdit } from "../../hooks/useInlineEdit";
import { inputClass } from "./inputClass";

interface Props {
	/** The stored name, shown as the page's `h2`. */
	value: string;
	/** Called with the trimmed text, only when it is non-empty and changed. */
	onSave: (trimmed: string) => Promise<void>;
	/** What the value is: `Title`, `Name` — the field's accessible name. */
	label: string;
}

/**
 * The name at the top of a detail page, edited in place: Enter saves, Escape
 * cancels. One component for every detail page — work, role, schedule — so
 * the three cannot drift.
 */
export default function InlineEditableHeading({
	value: stored,
	onSave,
	label,
}: Props) {
	const {
		editing,
		setEditing,
		value,
		setValue,
		saving,
		error,
		ref,
		save,
		cancel,
	} = useInlineEdit<HTMLInputElement>({
		initialValue: stored,
		onSave,
	});

	if (editing) {
		return (
			<div>
				<div className="flex items-center gap-2">
					<input
						ref={ref}
						aria-label={label}
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") save();
							if (e.key === "Escape") cancel();
						}}
						disabled={saving}
						className={`min-w-0 flex-1 rounded-lg bg-th-bg-primary px-3 py-2 text-lg font-bold text-th-text-primary ${inputClass}`}
					/>
					<button
						type="button"
						onClick={save}
						disabled={saving || !value.trim()}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-success hover:bg-th-bg-tertiary disabled:opacity-50"
						aria-label="Save"
					>
						{saving ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Check className="size-4" />
						)}
					</button>
					<button
						type="button"
						onClick={cancel}
						disabled={saving}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary"
						aria-label="Cancel"
					>
						<X className="size-4" />
					</button>
				</div>
				{error && (
					<p className="mt-1 text-xs text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="group flex items-start gap-1">
			<h2 className="min-w-0 flex-1 break-words text-lg font-bold text-th-text-primary">
				{stored}
			</h2>
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-th-text-muted opacity-80 transition-opacity hover:opacity-100 hover:bg-th-bg-tertiary hover:text-th-text-primary"
				aria-label={`Edit ${label.toLowerCase()}`}
			>
				<Pencil className="size-4" />
			</button>
		</div>
	);
}
