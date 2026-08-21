import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	FILE_SEARCH_QUERY_KEY,
	useFileSearch,
} from "../../hooks/useFileSearch";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh } from "../ui";
import FileSearchBar from "./FileSearchBar";
import FileSearchResults from "./FileSearchResults";
import FileTree from "./FileTree";

interface Props {
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
}

function FilesTab({ onSelectFile, activeFilePath }: Props) {
	const queryClient = useQueryClient();
	const [expandSignal, setExpandSignal] = useState(0);
	const [query, setQuery] = useState("");

	const handleRefresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["contents"] });
		queryClient.invalidateQueries({ queryKey: [FILE_SEARCH_QUERY_KEY] });
		setExpandSignal((s) => s + 1);
	}, [queryClient]);

	const { isActive } = useSidebarRefresh("files", handleRefresh);

	const prevActiveRef = useRef(isActive);
	useEffect(() => {
		if (isActive && !prevActiveRef.current) {
			setExpandSignal((s) => s + 1);
		}
		prevActiveRef.current = isActive;
	}, [isActive]);

	const inputRef = useRef<HTMLInputElement>(null);
	const handleSelectFile = useCallback(
		(path: string) => {
			// Dismiss the mobile keyboard before the sidebar closes, otherwise it
			// lingers on top of the closing animation.
			inputRef.current?.blur();
			onSelectFile(path);
		},
		[onSelectFile],
	);

	const search = useFileSearch(query, isActive);
	// Driven by the input alone, not by focus: tapping an option chip blurs the
	// input, which would otherwise flash the file tree back on screen.
	const inSearchMode = search.status !== "idle";

	return (
		<div
			className={isActive ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
		>
			<FileSearchBar
				query={query}
				onQueryChange={setQuery}
				showOptions={inSearchMode}
				isSearching={search.isFetching}
				inputRef={inputRef}
			/>

			{/* Both branches stay mounted so leaving search restores the tree's
			    expansion state, scroll position and FS watch subscriptions. */}
			<div className={inSearchMode ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
				<PullToRefresh onRefresh={handleRefresh}>
					<FileTree
						onSelectFile={onSelectFile}
						activeFilePath={activeFilePath}
						expandSignal={expandSignal}
						watchEnabled={isActive}
					/>
				</PullToRefresh>
			</div>

			<div className={inSearchMode ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
				<FileSearchResults
					search={search}
					onSelectFile={handleSelectFile}
					activeFilePath={activeFilePath}
				/>
			</div>
		</div>
	);
}

export default FilesTab;
