interface Props {
	className?: string;
}

function Spinner({ className = "" }: Props) {
	return (
		<output
			className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent ${className}`}
		>
			<span className="sr-only">Loading...</span>
		</output>
	);
}

export default Spinner;
