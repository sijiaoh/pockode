/**
 * The full-width switch above a page's list, choosing which list it shows —
 * the project list's `Current` / `Closed`, the Git workspace's three segments.
 * It holds no state: the segment is in the URL, and `onSelect` is a navigation
 * (docs/project-ui.md §5).
 *
 * No segment carries a count: where a count is a signal to act, the group
 * headings inside the list already carry it.
 */
export default function SegmentedControl<T extends string>({
	label,
	items,
	selected,
	onSelect,
}: {
	/** What the group chooses, for a screen reader. */
	label: string;
	items: readonly { value: T; label: string }[];
	selected: T;
	onSelect: (value: T) => void;
}) {
	return (
		// A group and not a tablist: the tab pattern promises a panel per tab and
		// an arrow-key walk between them, and this is one list under a filter.
		<fieldset
			aria-label={label}
			// `min-w-0` against the one thing a fieldset does that a div does not:
			// its `min-inline-size: min-content` would stop the segments sharing
			// the width of a narrow phone.
			className="flex min-w-0 shrink-0 gap-1 border-b border-th-border bg-th-bg-secondary p-1"
		>
			{items.map((item) => (
				<button
					key={item.value}
					type="button"
					aria-pressed={selected === item.value}
					onClick={() => onSelect(item.value)}
					className={`min-h-[44px] flex-1 rounded-md px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
						selected === item.value
							? "bg-th-bg-tertiary font-medium text-th-text-primary"
							: "text-th-text-muted hover:text-th-text-primary"
					}`}
				>
					{item.label}
				</button>
			))}
		</fieldset>
	);
}
