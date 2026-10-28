import { useEffect, useState } from "react";
import { worktreeActions } from "../lib/worktreeStore";
import { isWorktreeSwitchInFlight } from "../lib/wsStore";

/**
 * Whether a worktree switch is under way, for a reader of the git caches that
 * must not act on them meanwhile: they are keyed by nothing, so until the
 * switch settles — and the refetch it triggers lands — they still hold the
 * previous worktree's answers.
 */
export function useIsWorktreeSwitching(): boolean {
	// Seeded for a reader mounted while a switch is already under way.
	const [switching, setSwitching] = useState(isWorktreeSwitchInFlight);

	useEffect(() => {
		const offStart = worktreeActions.onWorktreeSwitchStart(() =>
			setSwitching(true),
		);
		const offEnd = worktreeActions.onWorktreeSwitchEnd(() =>
			setSwitching(false),
		);
		// Read again now the listeners are on: a switch that started or settled
		// between the render that seeded the state and this effect told nobody.
		setSwitching(isWorktreeSwitchInFlight());
		return () => {
			offStart();
			offEnd();
		};
	}, []);

	return switching;
}
