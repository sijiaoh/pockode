/**
 * The up-arrow-in-circle that marks "something else is installed" wherever
 * the panel says so — the header, a card's version line, the batch strip — in
 * an inline SVG, since this panel has no icon library (docs/cluster-ui.md).
 * Decorative: the text beside it always says the same in words.
 */
export function InstalledArrow({ testId }: { testId?: string }) {
	return (
		<svg
			className="h-4 w-4 shrink-0 text-th-accent"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			viewBox="0 0 24 24"
			aria-hidden="true"
			data-testid={testId}
		>
			<circle cx="12" cy="12" r="10" />
			<path d="m16 12-4-4-4 4" />
			<path d="M12 16V8" />
		</svg>
	);
}
