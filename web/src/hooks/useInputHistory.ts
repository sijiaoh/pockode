import { useCallback, useRef } from "react";

const STORAGE_KEY = "input_history";
const MAX_HISTORY = 100;

function loadHistory(): string[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item) => typeof item === "string");
	} catch {
		return [];
	}
}

function persistHistory(history: string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
	} catch {
		/* ignored */
	}
}

export function useInputHistory() {
	// -1 means we're at draft (current input), 0 is most recent history
	const indexRef = useRef(-1);
	const draftRef = useRef("");
	const historyRef = useRef<string[] | null>(null);

	const getHistory = useCallback(() => {
		if (historyRef.current === null) {
			historyRef.current = loadHistory();
		}
		return historyRef.current;
	}, []);

	const saveToHistory = useCallback(
		(content: string) => {
			const trimmed = content.trim();
			if (!trimmed) return;

			const history = getHistory();
			if (history.length > 0 && history[0] === trimmed) return;

			const newHistory = [trimmed, ...history].slice(0, MAX_HISTORY);
			historyRef.current = newHistory;
			persistHistory(newHistory);
		},
		[getHistory],
	);

	const resetNavigation = useCallback(() => {
		indexRef.current = -1;
		draftRef.current = "";
	}, []);

	const getPrevious = useCallback(
		(currentInput: string): string | null => {
			const history = getHistory();
			if (history.length === 0) return null;

			if (indexRef.current === -1) {
				draftRef.current = currentInput;
			}

			const nextIndex = indexRef.current + 1;
			if (nextIndex >= history.length) return null;

			indexRef.current = nextIndex;
			return history[nextIndex];
		},
		[getHistory],
	);

	const getNext = useCallback((): string | null => {
		if (indexRef.current < 0) return null;

		const nextIndex = indexRef.current - 1;
		indexRef.current = nextIndex;

		if (nextIndex === -1) {
			return draftRef.current;
		}

		const history = getHistory();
		return history[nextIndex] ?? null;
	}, [getHistory]);

	return {
		saveToHistory,
		getPrevious,
		getNext,
		resetNavigation,
	};
}
