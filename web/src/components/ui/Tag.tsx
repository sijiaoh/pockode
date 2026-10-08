/**
 * A short neutral label beside a name: `Recommended`, `Default`. Neutral on
 * purpose: accent or success would read as "already selected", and none of
 * these labels is a selection (docs/answering-ui.md, "What it draws"). Opaque,
 * so it stays legible on a selected row's tint; `leading-none` keeps it from
 * growing the line.
 */
export default function Tag({
	label,
	srSuffix,
	leading = false,
}: {
	label: string;
	/** Read after the label but not drawn: words the surrounding page already says. */
	srSuffix?: string;
	/** First on its line, so there is no name before it to be set apart from. */
	leading?: boolean;
}) {
	return (
		<>
			{/* Without a separator the two text runs are read as one word. */}
			{!leading && <span className="sr-only">, </span>}
			<span
				className={`${leading ? "" : "ml-1.5 "}inline-block whitespace-nowrap rounded bg-th-bg-tertiary px-1.5 py-0.5 align-middle text-xs leading-none text-th-text-muted`}
			>
				{label}
				{srSuffix && <span className="sr-only">{srSuffix}</span>}
			</span>
		</>
	);
}
