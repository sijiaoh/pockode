/** Above this the exact number stops informing any decision. */
const MAX_COUNT = 99;

/** The badge's own truncation, so a spoken label can say what is displayed. */
export function formatBadgeCount(count: number): string {
	return count > MAX_COUNT ? `${MAX_COUNT}+` : String(count);
}

interface Props {
	/** Hidden entirely at 0 or undefined — nothing to report reads as no badge. */
	count: number | undefined;
	className?: string;
}

/**
 * Notification badge carrying a count.
 * Use within a `relative` positioned parent.
 */
export default function BadgeCount({ count, className = "" }: Props) {
	if (!count) return null;
	return (
		<span
			aria-hidden="true"
			className={`absolute flex h-4 min-w-4 items-center justify-center rounded-full bg-th-accent px-1 text-[10px] font-medium leading-none text-th-accent-text tabular-nums ${className}`}
		>
			{formatBadgeCount(count)}
		</span>
	);
}
