/**
 * Text whose backtick spans are code — as the server writes its install
 * hints, and as the update copy names files — drawn in mono without the
 * backticks, breaking anywhere since they are mostly paths.
 */
export function CodeText({ text }: { text: string }) {
	return (
		<>
			{text.split("`").map((part, i) =>
				i % 2 === 1 ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: the split is the order
					<code key={i} className="break-all font-mono">
						{part}
					</code>
				) : (
					part
				),
			)}
		</>
	);
}
