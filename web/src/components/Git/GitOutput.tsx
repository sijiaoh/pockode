interface Props {
	/** git's own stdout/stderr, shown verbatim. */
	children: string;
}

/**
 * git's own words, wherever the panel reports a failure.
 *
 * Always capped and scrollable: a rejected push runs to a dozen lines of
 * `hint:`, a checkout refusal names every file in the way, and a pre-commit hook
 * can dump a whole test run. Inside a height-capped sheet those lines come out
 * of the very buttons and fields the message is telling the user to use, so the
 * cap belongs to the output itself rather than to each place that shows it. It
 * was written out four times before this and no two of them fully agreed: a
 * taller cap in one, `break-words` in only one.
 */
function GitOutput({ children }: Props) {
	return (
		<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-th-bg-tertiary p-2 font-mono text-xs text-th-text-secondary">
			{children}
		</pre>
	);
}

export default GitOutput;
