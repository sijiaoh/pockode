interface Props {
	name: string;
	/** Muted words after the name that are never the part cut, as `· rebasing`. */
	suffix?: string;
}

/**
 * A ref name that truncates at the *head*, so `…/git-ui` keeps the part that
 * tells branches apart instead of the shared prefix.
 *
 * The RTL container moves the ellipsis to the start of the line; the inner LTR
 * isolate keeps the name itself in reading order.
 */
function BranchName({ name, suffix }: Props) {
	const nameSpan = (
		<span
			className={`min-w-0 truncate text-left text-sm [direction:rtl] ${
				suffix ? "" : "flex-1"
			}`}
			title={name}
		>
			<bdi dir="ltr">{name}</bdi>
		</span>
	);
	if (!suffix) return nameSpan;
	return (
		<span className="flex min-w-0 flex-1 items-baseline gap-1">
			{nameSpan}
			<span className="shrink-0 text-sm text-th-text-muted">{suffix}</span>
		</span>
	);
}

export default BranchName;
