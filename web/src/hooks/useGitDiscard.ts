import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { invalidateGitQueries } from "./gitQueries";

/**
 * Throws away unstaged changes.
 *
 * Nothing is updated optimistically: the server decides per path whether the
 * change is restored or the file is deleted, and a list that removed rows
 * before hearing back would show a file as gone that git refused to remove.
 */
export function useGitDiscard() {
	const queryClient = useQueryClient();
	const discard = useWSStore((s) => s.actions.discard);

	return useMutation({
		mutationFn: (paths: string[]) => discard(paths),
		// onSettled rather than onSuccess, unlike the panel's other mutations: a
		// discard is several git invocations, and a failure part-way through has
		// already removed files. Refreshing only on success would leave the list
		// showing files that are gone until GitWatcher's next poll.
		//
		// Deliberately not returned: react-query would fold the refetch into the
		// mutation's outcome, and the panel would report a discard that did happen
		// as a failure because the refresh behind it failed.
		onSettled: () => {
			invalidateGitQueries(queryClient);
		},
	});
}
