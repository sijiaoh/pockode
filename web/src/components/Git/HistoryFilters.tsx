import { FileText, Info, X } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import { composing } from "../../utils/keyboard";
import { iconButtonClass, inputClass } from "../ui";

interface Props {
	searchOpen: boolean;
	text: string;
	onTextChange: (text: string) => void;
	/** Clears the search and closes its row. */
	onCancel: () => void;
	inputRef: RefObject<HTMLInputElement | null>;
	/** What is being searched and filtered — the URL's, not the field's. */
	q: string | undefined;
	file: string | undefined;
	onClearFile: () => void;
}

/**
 * What stands between the history header and the list while a search or a
 * file filter is on: the search row, the file chip, and why the graph is gone
 * (docs/git-history-ui.md#search-and-file-filter).
 */
function HistoryFilters({
	searchOpen,
	text,
	onTextChange,
	onCancel,
	inputRef,
	q,
	file,
	onClearFile,
}: Props) {
	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		// Mid-composition the keys belong to the IME: Escape cancels the
		// composition, Enter confirms it.
		if (composing(e)) {
			if (e.key === "Escape") e.stopPropagation();
			return;
		}
		if (e.key === "Escape") {
			// Claimed, as every surface that closes on Escape claims it
			// (docs/answering-ui.md#who-owns-escape).
			e.stopPropagation();
			onCancel();
		} else if (e.key === "Enter") {
			// Results are already live, so Enter just means "done typing".
			e.currentTarget.blur();
		}
	};

	const notice = q
		? file
			? "searching and filtering"
			: "searching"
		: file
			? "filtering"
			: null;

	if (!searchOpen && !file && !notice) return null;
	return (
		<div className="flex shrink-0 flex-col gap-2 border-b border-th-border bg-th-bg-secondary px-2 py-2">
			{searchOpen && (
				<div className="flex items-center gap-2">
					<input
						ref={inputRef}
						type="search"
						value={text}
						onChange={(e) => onTextChange(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Search commit messages"
						aria-label="Search commit messages"
						enterKeyHint="search"
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="off"
						spellCheck={false}
						className={`min-h-[36px] min-w-0 flex-1 rounded-md bg-th-bg-primary px-3 text-sm text-th-text-primary placeholder:text-th-text-muted pointer-coarse:min-h-11 ${inputClass}`}
					/>
					<button
						type="button"
						onClick={onCancel}
						className="min-h-[36px] shrink-0 rounded-md px-3 text-sm text-th-accent hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
					>
						Cancel
					</button>
				</div>
			)}
			{file && (
				<div className="flex min-w-0 items-center gap-2 pl-1 text-sm text-th-text-primary">
					<FileText
						className="size-4 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
					{/* Truncated at the head: the file name is the end worth keeping. */}
					<span className="min-w-0 flex-1 truncate [direction:rtl]">
						<bdi dir="ltr">{file}</bdi>
					</span>
					<button
						type="button"
						onClick={onClearFile}
						aria-label="Clear file filter"
						title="Clear file filter"
						className={iconButtonClass()}
					>
						<X className="size-4" aria-hidden="true" />
					</button>
				</div>
			)}
			{notice && (
				// The reason, not an error: it stays as long as the filter does.
				<p className="flex gap-1.5 pl-1 text-xs text-th-text-muted">
					<Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
					<span>
						No graph while {notice} — matching commits aren't each other's
						parents, so lines between them would be wrong.
					</span>
				</p>
			)}
		</div>
	);
}

export default HistoryFilters;
