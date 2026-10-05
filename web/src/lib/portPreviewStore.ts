import { create } from "zustand";
import { parsePort } from "./portPreview";

// One key, not one per worktree: ports belong to the machine.
const STORAGE_KEY = "pockode:preview-ports";
const MAX_RECENT = 5;

function loadRecentPorts(): number[] {
	try {
		const parsed: unknown = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "[]",
		);
		if (!Array.isArray(parsed)) return [];
		const ports = parsed.filter(
			(item): item is number =>
				typeof item === "number" && parsePort(String(item)) === item,
		);
		// Rows are keyed by port, so a duplicate would collide.
		return [...new Set(ports)].slice(0, MAX_RECENT);
	} catch {
		return [];
	}
}

function setRecentPorts(recentPorts: number[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(recentPorts));
	} catch {
		// Storage can be full or disabled; the list still works for this tab.
	}
	usePortPreviewStore.setState({ recentPorts });
}

interface PortPreviewState {
	/** Most recently opened first. */
	recentPorts: number[];
}

export const usePortPreviewStore = create<PortPreviewState>(() => ({
	recentPorts: loadRecentPorts(),
}));

export const portPreviewActions = {
	/** Records `port` as just opened, moving it to the front. */
	recordPort: (port: number) => {
		const { recentPorts } = usePortPreviewStore.getState();
		setRecentPorts(
			[port, ...recentPorts.filter((p) => p !== port)].slice(0, MAX_RECENT),
		);
	},

	removePort: (port: number) => {
		const { recentPorts } = usePortPreviewStore.getState();
		setRecentPorts(recentPorts.filter((p) => p !== port));
	},
};
