interface Props {
	name: string;
}

/**
 * A ref name that truncates at the *head*, so `…/git-ui` keeps the part that
 * tells branches apart instead of the shared prefix.
 *
 * The RTL container moves the ellipsis to the start of the line; the inner LTR
 * isolate keeps the name itself in reading order.
 */
function BranchName({ name }: Props) {
	return (
		<span
			className="min-w-0 flex-1 truncate text-left text-sm [direction:rtl]"
			title={name}
		>
			<bdi dir="ltr">{name}</bdi>
		</span>
	);
}

export default BranchName;
