import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useWorktreeUploads } from "../lib/uploadStore";
import type { ContentsResponse, Entry } from "../types/contents";
import { contentsQueryKey, useContents } from "./useContents";

/**
 * Asks, for any directory, which names are already spoken for in it.
 *
 * Both the listing on disk and the queue: an upload still in flight has no
 * entry yet, but the name is as taken as any other. Shared rather than local to
 * one caller, so the naming sheets and the upload queue's "Keep both" cannot
 * give different answers to the same question.
 */
export function useTakenNamesIn(): (dir: string) => Set<string> {
	const queryClient = useQueryClient();
	const uploads = useWorktreeUploads();

	return useCallback(
		(dir: string): Set<string> => {
			const cached = queryClient.getQueryData<ContentsResponse>(
				contentsQueryKey(dir),
			);
			const entries: Entry[] = Array.isArray(cached) ? cached : [];

			const taken = new Set<string>();
			for (const entry of entries) taken.add(entry.name);
			for (const item of uploads) {
				if (item.destPath !== dir) continue;
				// A cancelled or failed upload gave its name back.
				if (item.status === "cancelled" || item.status === "failed") continue;
				taken.add(item.name);
			}
			return taken;
		},
		[queryClient, uploads],
	);
}

/**
 * The same answer for one directory, or null while its listing is still on its
 * way — which is what a naming sheet needs to tell "that name is taken" apart
 * from "no answer yet".
 *
 * Pass null for `dir` when no sheet is open; the listing is only fetched while
 * one is. A folder that has never been expanded has no cached listing, which is
 * why this fetches rather than reading the cache and calling an empty result an
 * answer.
 *
 * A listing that *failed* is not null but empty, so the sheet stops waiting and
 * lets the name be submitted. Null means "still coming", and holding the button
 * behind a spinner for an answer that will never arrive would make naming
 * anything in a folder that cannot be listed impossible. Giving up the local
 * check costs nothing that matters: `file.create` and `file.rename` are the
 * only authority on a taken name either way, and their refusal arrives in this
 * same sheet under this same field — exactly as it does for the name a
 * case-insensitive filesystem turns down.
 */
export function useTakenNames(dir: string | null): Set<string> | null {
	const takenNamesIn = useTakenNamesIn();
	const contents = useContents(dir ?? "", dir !== null);
	// `isPending`, not `isSuccess`: a query that has errored is no longer
	// pending, which is what routes a failed listing to the empty answer above.
	return dir !== null && !contents.isPending ? takenNamesIn(dir) : null;
}
