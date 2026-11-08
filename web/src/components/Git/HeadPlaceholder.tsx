import { GitBranch } from "lucide-react";

interface Props {
	isLoading: boolean;
	error: unknown;
}

/**
 * Where the branch name goes while there is none to show: a skeleton while the
 * first read is out, and a plain "unavailable" once it has failed — for the
 * workspace's top bar and the sidebar's Git overview alike.
 *
 * Only while there is no name at all: a refetch that fails keeps the name
 * already known, so callers render this for a missing head, not for an error.
 */
function HeadPlaceholder({ isLoading, error }: Props) {
	if (isLoading) {
		return (
			<div className="flex flex-1 items-center gap-2 px-2">
				<div className="h-4 w-4 shrink-0 animate-pulse rounded bg-th-text-muted/20" />
				<div className="h-4 flex-1 animate-pulse rounded bg-th-text-muted/20" />
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-sm text-th-error">
			<GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />
			<span
				className="truncate"
				title={error instanceof Error ? error.message : undefined}
			>
				Branch unavailable
			</span>
		</div>
	);
}

export default HeadPlaceholder;
