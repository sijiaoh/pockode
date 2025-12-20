interface Props {
	className?: string;
}

function Spinner({ className = "" }: Props) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: spinner is not a form output, role="status" is for screen readers
		<span
			role="status"
			aria-label="Loading"
			className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent ${className}`}
		>
			<span className="sr-only">Loading...</span>
		</span>
	);
}

export default Spinner;
