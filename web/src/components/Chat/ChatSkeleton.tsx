import { useEffect, useState } from "react";

// Alternating sides at varying widths so the block reads as a conversation
// rather than a generic loading box. Staggered pulses keep the four rows from
// breathing in unison.
const ROWS = [
	{ align: "justify-start", size: "h-16 w-3/5", delay: "" },
	{
		align: "justify-end",
		size: "h-10 w-2/5",
		delay: "[animation-delay:120ms]",
	},
	{
		align: "justify-start",
		size: "h-24 w-4/5",
		delay: "[animation-delay:240ms]",
	},
	{
		align: "justify-end",
		size: "h-10 w-1/3",
		delay: "[animation-delay:360ms]",
	},
];

interface Props {
	/**
	 * False for the first moments of a wait, when the destination is expected to
	 * arrive fast enough that any indicator would be more distracting than the
	 * wait. The rows stay laid out and merely invisible, so revealing them costs
	 * no layout shift.
	 */
	showRows: boolean;
}

/**
 * Stands in for the message area while the destination session's history is on
 * its way. Padding and bottom alignment match `MessageList`'s content layer, so
 * the real messages replace it without shifting.
 */
function ChatSkeleton({ showRows }: Props) {
	// Kept as state rather than read straight from the prop so the rows mount
	// hidden and then transition; opacity applied in the same paint would jump.
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (showRows) setVisible(true);
	}, [showRows]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: loading indicator is not a form output
		<div
			role="status"
			aria-busy="true"
			aria-label="Loading conversation"
			className={`flex min-h-0 flex-1 flex-col justify-end px-3 transition-opacity duration-150 sm:px-4 ${
				visible ? "opacity-100" : "opacity-0"
			}`}
		>
			{ROWS.map((row) => (
				<div
					key={row.size}
					className={`flex py-1.5 sm:py-2 ${row.align}`}
					aria-hidden="true"
				>
					<div
						className={`animate-pulse rounded-lg bg-th-text-muted/20 ${row.size} ${row.delay}`}
					/>
				</div>
			))}
		</div>
	);
}

export default ChatSkeleton;
