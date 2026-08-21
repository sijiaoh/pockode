import { EyeOff, FileText, Search, X } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import { useFilesSearchStore } from "../../lib/filesSearchStore";
import ToggleChip from "../common/ToggleChip";
import { Spinner } from "../ui";

interface Props {
	query: string;
	onQueryChange: (query: string) => void;
	/** The option chips only make sense once a search is running. */
	showOptions: boolean;
	isSearching: boolean;
	inputRef: RefObject<HTMLInputElement | null>;
}

function FileSearchBar({
	query,
	onQueryChange,
	showOptions,
	isSearching,
	inputRef,
}: Props) {
	const respectGitignore = useFilesSearchStore(
		(state) => state.respectGitignore,
	);
	const searchContent = useFilesSearchStore((state) => state.searchContent);
	const toggleRespectGitignore = useFilesSearchStore(
		(state) => state.toggleRespectGitignore,
	);
	const toggleSearchContent = useFilesSearchStore(
		(state) => state.toggleSearchContent,
	);

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			if (query.length > 0) {
				// The sidebar closes itself on Escape from a document listener; without
				// this the whole panel would disappear instead of just the search.
				// With nothing to clear the key is left alone, so Escape still closes
				// the sidebar as it does everywhere else.
				e.stopPropagation();
				onQueryChange("");
			}
			e.currentTarget.blur();
		} else if (e.key === "Enter") {
			// Results are already live, so Enter just means "done typing".
			e.currentTarget.blur();
		}
	};

	return (
		<>
			<div className="flex shrink-0 items-center gap-2 p-2">
				<div className="flex min-h-[44px] flex-1 items-center gap-2 rounded-lg border border-th-border bg-th-bg-primary px-3 focus-within:border-th-border-focus focus-within:ring-2 focus-within:ring-th-accent/20">
					{isSearching ? (
						<Spinner
							size="h-4 w-4"
							variant="current"
							className="shrink-0 text-th-accent"
							srText="Searching"
						/>
					) : (
						<Search
							className="h-4 w-4 shrink-0 text-th-text-muted"
							aria-hidden="true"
						/>
					)}
					<input
						ref={inputRef}
						// Not type="search": WebKit adds its own clear button next to ours.
						type="text"
						value={query}
						onChange={(e) => onQueryChange(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Search files"
						aria-label="Search files"
						inputMode="search"
						enterKeyHint="search"
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="off"
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:outline-none"
					/>
					{query && (
						<button
							type="button"
							onClick={() => onQueryChange("")}
							aria-label="Clear search"
							className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-th-text-muted transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary active:scale-95"
						>
							<X className="h-4 w-4" aria-hidden="true" />
						</button>
					)}
				</div>
			</div>

			{showOptions && (
				<div className="flex shrink-0 items-center gap-2 px-2 pb-2">
					<ToggleChip
						icon={EyeOff}
						label=".gitignore"
						title="Respect .gitignore"
						pressed={respectGitignore}
						onToggle={toggleRespectGitignore}
					/>
					<ToggleChip
						icon={FileText}
						label="File contents"
						title="Search inside file contents"
						pressed={searchContent}
						onToggle={toggleSearchContent}
					/>
				</div>
			)}
		</>
	);
}

export default FileSearchBar;
