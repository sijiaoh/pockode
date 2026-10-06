import { Spinner } from "@pockode/shared";
import type { ReactNode } from "react";
import { isNotFoundError } from "../../hooks/useContents";

interface Props {
	isLoading?: boolean;
	error?: Error | null;
	children: ReactNode;
}

const actionButtonBase =
	"flex items-center justify-center rounded border border-th-border bg-th-bg-tertiary transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95";

/**
 * A bordered icon action in the bar under a file or a diff.
 *
 * 36px for a mouse, 44px for a thumb. It used to be 32px for everyone, which
 * is under the floor for either; the bar has nothing but padding around these,
 * so growing the box costs a few pixels of bar height on a touch device and
 * nothing at all on a desktop. See docs/responsive-ui.md.
 */
const actionIconButtonSize = "size-9 pointer-coarse:size-11";

export const actionIconButtonClass = `${actionButtonBase} ${actionIconButtonSize} text-th-text-secondary hover:border-th-border-focus hover:text-th-text-primary`;

export const actionIconButtonDisabledClass = `${actionButtonBase} ${actionIconButtonSize} opacity-50 cursor-not-allowed`;

export const getActionIconButtonClass = (enabled: boolean) =>
	enabled ? actionIconButtonClass : actionIconButtonDisabledClass;

/**
 * The scrolling body of a file, diff or commit page, standing in for it while
 * it loads or fails. The page's heading is its own `PageHeader`, drawn in the
 * app header.
 */
export default function ContentView({ isLoading, error, children }: Props) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-auto">
				{isLoading ? (
					<div className="flex items-center justify-center p-8">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				) : error ? (
					<div className="p-4 text-center text-th-text-muted">
						{isNotFoundError(error) ? (
							<div>File not found</div>
						) : (
							<>
								<div className="text-th-error">Failed to load</div>
								<div className="mt-1 text-sm">{error.message}</div>
							</>
						)}
					</div>
				) : (
					children
				)}
			</div>
		</div>
	);
}
