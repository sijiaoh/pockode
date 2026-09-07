import { create } from "zustand";

const RESPECT_GITIGNORE_KEY = "files-search-respect-gitignore";
const SEARCH_CONTENT_KEY = "files-search-content";

// Defaults to on, so an absent entry must read as true and only an explicit
// "false" turns it off.
function loadRespectGitignore(): boolean {
	return localStorage.getItem(RESPECT_GITIGNORE_KEY) !== "false";
}

function loadSearchContent(): boolean {
	return localStorage.getItem(SEARCH_CONTENT_KEY) === "true";
}

interface FilesSearchState {
	respectGitignore: boolean;
	searchContent: boolean;
	toggleRespectGitignore: () => void;
	toggleSearchContent: () => void;
}

export const useFilesSearchStore = create<FilesSearchState>((set) => ({
	respectGitignore: loadRespectGitignore(),
	searchContent: loadSearchContent(),
	toggleRespectGitignore: () =>
		set((state) => {
			const next = !state.respectGitignore;
			localStorage.setItem(RESPECT_GITIGNORE_KEY, String(next));
			return { respectGitignore: next };
		}),
	toggleSearchContent: () =>
		set((state) => {
			const next = !state.searchContent;
			localStorage.setItem(SEARCH_CONTENT_KEY, String(next));
			return { searchContent: next };
		}),
}));
