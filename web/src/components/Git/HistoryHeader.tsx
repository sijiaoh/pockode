import {
	ChevronDown,
	GitBranch,
	GitCommitVertical,
	GitFork,
	Search,
} from "lucide-react";
import { type RefObject, useState } from "react";
import { describeScope } from "../../lib/commitHistory";
import type { GitHistoryScope } from "../../types/git";
import MenuRow from "../common/MenuRow";
import { iconButtonClass, Sheet } from "../ui";

const SCOPES = [
	{ value: "current", icon: GitBranch },
	{ value: "all", icon: GitFork },
	{ value: "mainline", icon: GitCommitVertical },
] as const satisfies readonly { value: GitHistoryScope; icon: unknown }[];

interface Props {
	scope: GitHistoryScope;
	/** For the `Current + main` label; undefined until known, or where git names none. */
	defaultBranch: string | undefined;
	/**
	 * Over the whole range, from the server's first page; absent at zero and
	 * while filtered, where it would count the range and not the matches.
	 */
	unpushedCount: number;
	onChangeScope: (scope: GitHistoryScope) => void;
	/** Opens the search row, or puts the cursor back in it. */
	onSearch: () => void;
	/** Where focus returns when the search row closes. */
	searchButtonRef: RefObject<HTMLButtonElement | null>;
}

/**
 * The History list's header: which range is listed, and how much of it is not
 * pushed, and the way into searching it
 * (docs/git-history-ui.md#the-history-header).
 *
 * The range is a sheet rather than a second segmented control: three labels
 * this long do not fit beside the count and the search at 300px.
 */
function HistoryHeader({
	scope,
	defaultBranch,
	unpushedCount,
	onChangeScope,
	onSearch,
	searchButtonRef,
}: Props) {
	const [picking, setPicking] = useState(false);
	const { label } = describeScope(scope, defaultBranch);

	return (
		<div className="flex min-h-[44px] shrink-0 items-center gap-2 border-b border-th-border bg-th-bg-secondary px-2">
			<button
				type="button"
				onClick={() => setPicking(true)}
				aria-label={`Show: ${label}`}
				className="flex min-h-[36px] min-w-0 items-center gap-1 rounded-md px-2 text-sm text-th-text-primary hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
			>
				<span className="truncate">{label}</span>
				<ChevronDown className="size-4 shrink-0" aria-hidden="true" />
			</button>
			<span className="flex-1" />
			{unpushedCount > 0 && (
				// The hollow glyph is the legend for the hollow dots below it.
				<span className="flex shrink-0 items-center gap-1 text-xs text-th-text-secondary">
					<svg
						width={9}
						height={9}
						aria-hidden="true"
						focusable="false"
						className="shrink-0"
					>
						<circle
							cx={4.5}
							cy={4.5}
							r={3.5}
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
						/>
					</svg>
					↑{unpushedCount} unpushed
				</span>
			)}
			<button
				ref={searchButtonRef}
				type="button"
				onClick={onSearch}
				aria-label="Search commit messages"
				title="Search commit messages"
				className={iconButtonClass()}
			>
				<Search className="size-4" aria-hidden="true" />
			</button>
			{picking && (
				<Sheet title="Show" onClose={() => setPicking(false)}>
					<div className="py-1">
						{SCOPES.map(({ value, icon }) => {
							const words = describeScope(value, defaultBranch);
							return (
								<MenuRow
									key={value}
									icon={icon}
									label={words.label}
									description={words.description}
									checked={value === scope}
									onClick={() => {
										setPicking(false);
										if (value !== scope) onChangeScope(value);
									}}
								/>
							);
						})}
					</div>
				</Sheet>
			)}
		</div>
	);
}

export default HistoryHeader;
