import type { ReactNode } from "react";
import { Details } from "../../CliLogin/loginParts";
import Skeleton from "../../ui/Skeleton";

interface Props {
	icon?: ReactNode;
	/** Undefined while the value is not read yet: the row draws its skeleton. */
	title: string | undefined;
	subtitle?: ReactNode;
	/** At most one button. */
	action?: ReactNode;
	/** The row cannot act right now. */
	dimmed?: boolean;
	/**
	 * An attention state: its title may wrap rather than be cut, since the
	 * height it adds is news, like a notice's.
	 */
	wrap?: boolean;
	/** Names what the skeleton waits for. */
	loadingLabel?: string;
	/** A `CliRowNotice`, for attention states only. */
	notice?: ReactNode;
}

/** What a state draws in a row, its notice's parts included. */
export type CliRowState = Omit<Props, "notice" | "loadingLabel"> & {
	notice?: NoticeProps;
};

/**
 * One line of a CLI's card, in a box whose height no ordinary state changes
 * (docs/cli-update-ui.md, "Where it lives"): the title and the subtitle are
 * always rendered and do not wrap, and the action sits beside them, so a value
 * arriving or a button appearing fills the box instead of reshaping the card.
 * Only an attention state adds height — `notice`, and a `wrap` title.
 */
export default function CliRow({
	icon,
	title,
	subtitle,
	action,
	dimmed,
	wrap,
	loadingLabel,
	notice,
}: Props) {
	const loading = title === undefined;
	return (
		<div>
			<div className="flex min-h-11 items-center gap-3">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<span
						className={`flex h-9 w-4 shrink-0 ${dimmed ? "opacity-60" : ""}`}
						aria-hidden="true"
					>
						<span className="flex h-5 w-4 items-center justify-center">
							{loading ? <Skeleton className="h-4 w-4 rounded-full" /> : icon}
						</span>
					</span>
					<div className="min-w-0 flex-1">
						{loading ? (
							<>
								<Skeleton
									className="my-[3px] h-3.5 w-28 rounded"
									label={loadingLabel}
								/>
								<Skeleton className="my-0.5 h-3 w-40 max-w-full rounded" />
							</>
						) : (
							<>
								{/* Dimmed by colour, not opacity: the muted subtitle under an
								    opacity would fall below text contrast. */}
								<p
									className={`text-sm leading-5 ${wrap ? "break-words" : "truncate"} ${
										dimmed ? "text-th-text-muted" : "text-th-text-primary"
									}`}
								>
									{title}
								</p>
								<p className="truncate text-xs leading-4 text-th-text-muted">
									{subtitle || " "}
								</p>
							</>
						)}
					</div>
				</div>
				{action && (
					<div className="flex shrink-0 items-center gap-2">{action}</div>
				)}
			</div>
			{notice}
		</div>
	);
}

interface NoticeProps {
	body?: ReactNode;
	/** A command's own output, collapsed under "Details". */
	details?: string;
	/** Resets Details' open state when it is about something else. */
	detailsKey?: string;
	detailsOpen?: boolean;
	/** An action's error, in the server's words. */
	error?: string | null;
	footer?: ReactNode;
}

/**
 * What a row in an attention state says beyond its one line: why, what to do,
 * and the secondary actions. Indented to the row's text.
 */
export function CliRowNotice({
	body,
	details,
	detailsKey,
	detailsOpen,
	error,
	footer,
}: NoticeProps) {
	if (!body && !details && !error && !footer) return null;
	return (
		<div className="space-y-2 pt-1 pl-7">
			{body && <p className="break-words text-xs text-th-text-muted">{body}</p>}
			{details && (
				<Details key={detailsKey} details={details} defaultOpen={detailsOpen} />
			)}
			{error && (
				<p className="break-words text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
			{footer && <div className="flex justify-end gap-2">{footer}</div>}
		</div>
	);
}
