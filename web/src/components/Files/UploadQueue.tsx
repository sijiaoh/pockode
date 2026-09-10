import {
	AlertCircle,
	Check,
	ChevronDown,
	ChevronUp,
	File,
	Upload,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type UploadItem, uploadActions } from "../../lib/uploadStore";

interface Props {
	/** Entries of the worktree on screen, in the order they were queued. */
	items: UploadItem[];
	/** Send this one again, replacing what is already there. */
	onReplace: (item: UploadItem) => void;
	/** Send this one again under a free name. */
	onKeepBoth: (item: UploadItem) => void;
}

function isRunning(item: UploadItem): boolean {
	return item.status === "queued" || item.status === "uploading";
}

/**
 * Bytes sent across the whole queue, so one big file does not read as one file.
 *
 * Every file counts for at least a byte: a queue of empty ones weighs nothing
 * and would otherwise sit at 0% from start to finish.
 */
function overallProgress(items: UploadItem[]): number {
	const weight = (item: UploadItem) => Math.max(item.file.size, 1);
	const total = items.reduce((sum, item) => sum + weight(item), 0);
	const sent = items.reduce((sum, item) => {
		if (item.status === "done") return sum + weight(item);
		if (item.status === "uploading") return sum + weight(item) * item.progress;
		return sum;
	}, 0);
	return Math.round((sent / total) * 100);
}

function summarize(items: UploadItem[]): string {
	const running = items.filter(isRunning).length;
	if (running > 0) {
		const finished = items.length - running;
		return `Uploading ${finished + 1} of ${items.length} · ${overallProgress(items)}%`;
	}

	const done = items.filter((item) => item.status === "done").length;
	const failed = items.filter((item) => item.status === "failed").length;
	const cancelled = items.filter((item) => item.status === "cancelled").length;
	const parts = [`${done} uploaded`];
	if (failed > 0) parts.push(`${failed} failed`);
	if (cancelled > 0) parts.push(`${cancelled} cancelled`);
	return parts.join(" · ");
}

function statusText(item: UploadItem): string {
	switch (item.status) {
		case "queued":
			return "—";
		case "uploading":
			return `${Math.round(item.progress * 100)}%`;
		case "cancelled":
			// The reason, when there is one, is on the line below.
			return "Cancelled";
		default:
			return "";
	}
}

interface RowProps {
	item: UploadItem;
	onReplace: (item: UploadItem) => void;
	onKeepBoth: (item: UploadItem) => void;
}

function UploadRow({ item, onReplace, onKeepBoth }: RowProps) {
	return (
		<li className="px-3 py-1.5">
			<div className="flex items-center gap-2 text-xs">
				<File
					className="h-3.5 w-3.5 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<span className="min-w-0 flex-1 truncate text-th-text-primary">
					{item.name}
				</span>
				{/* A dot for the root: the destination column is only useful when the
				    queue holds files bound for different folders. */}
				<span className="max-w-[6rem] shrink-0 truncate text-th-text-muted">
					{item.destPath || "."}
				</span>
				{item.status === "done" ? (
					<>
						<Check
							className="h-4 w-4 shrink-0 text-th-success"
							aria-hidden="true"
						/>
						<span className="sr-only">Uploaded</span>
					</>
				) : item.status === "failed" ? (
					<>
						<AlertCircle
							className="h-4 w-4 shrink-0 text-th-error"
							aria-hidden="true"
						/>
						<span className="sr-only">Failed</span>
					</>
				) : (
					<span className="w-9 shrink-0 text-right text-th-text-muted">
						{statusText(item)}
					</span>
				)}
			</div>

			{item.status === "uploading" && (
				<div className="mt-1 h-[1.5px] w-full overflow-hidden rounded-full bg-th-bg-tertiary">
					<div
						className="h-full bg-th-accent transition-[width]"
						style={{ width: `${Math.round(item.progress * 100)}%` }}
					/>
				</div>
			)}

			{/* Cancelled rows carry a reason too: "worktree changed" is the only
			    account the user gets of uploads a switch abandoned. */}
			{(item.status === "failed" || item.status === "cancelled") &&
				item.error && (
					<div className="mt-0.5 flex flex-wrap items-center gap-2 pl-5">
						{/* `break-words` and not `truncate`: the messages the server
						    phrases itself — a `409`, an `internal` fault — name a path
						    from the workspace root, and a path offers no space to wrap
						    at. Left to overflow it runs over the buttons beside it. */}
						<span
							className={`min-w-0 flex-1 break-words text-xs ${item.status === "failed" ? "text-th-error" : "text-th-text-muted"}`}
						>
							{item.error}
						</span>
						{/* The file's name is in every label: several failed rows would
						    otherwise offer a screen reader a column of "Retry". */}
						{item.status === "failed" && item.conflict === "file" && (
							<button
								type="button"
								onClick={() => onReplace(item)}
								aria-label={`Replace ${item.name}`}
								className="shrink-0 rounded px-1.5 py-0.5 text-xs text-th-error hover:bg-th-error/10"
							>
								Replace
							</button>
						)}
						{item.status === "failed" && item.conflict !== "none" && (
							<button
								type="button"
								onClick={() => onKeepBoth(item)}
								aria-label={`Keep both copies of ${item.name}`}
								className="shrink-0 rounded px-1.5 py-0.5 text-xs text-th-accent hover:bg-th-accent/10"
							>
								Keep both
							</button>
						)}
						{item.status === "failed" &&
							item.conflict === "none" &&
							item.canRetry && (
								<button
									type="button"
									onClick={() => uploadActions.retry(item.id)}
									aria-label={`Retry ${item.name}`}
									className="shrink-0 rounded px-1.5 py-0.5 text-xs text-th-accent hover:bg-th-accent/10"
								>
									Retry
								</button>
							)}
					</div>
				)}
		</li>
	);
}

/**
 * The upload queue, docked at the bottom of the Files tab.
 *
 * It lives inside the tab rather than the sidebar shell: the shell would cost
 * every tab a permanent strip of vertical space for something that happens
 * rarely. What the other tabs get instead is the badge on the Files icon.
 */
function UploadQueue({ items, onReplace, onKeepBoth }: Props) {
	const [isExpanded, setIsExpanded] = useState(false);
	const running = items.some(isRunning);
	const hasFailure = items.some((item) => item.status === "failed");

	// The queue holds `File` objects and nothing else; a reload loses the files
	// themselves, not just their progress.
	useEffect(() => {
		if (!running) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [running]);

	// A failure is where the choices are — Replace, Keep both, Retry all live on
	// the row — so the summary alone would hide the only thing to do about it.
	// Only on the transition into failing, which leaves a panel the user has
	// since collapsed collapsed.
	useEffect(() => {
		if (hasFailure) setIsExpanded(true);
	}, [hasFailure]);

	if (items.length === 0) return null;

	const failedRetryable = items.filter(
		(item) => item.status === "failed" && item.canRetry,
	);
	const closeLabel = running ? "Cancel all uploads" : "Dismiss uploads";

	return (
		<div className="shrink-0 border-t border-th-border bg-th-bg-secondary">
			<div className="flex min-h-[36px] items-center gap-2 px-3">
				<Upload
					className="h-3.5 w-3.5 shrink-0 text-th-accent"
					aria-hidden="true"
				/>
				<span className="min-w-0 flex-1 truncate text-xs text-th-text-secondary">
					{summarize(items)}
				</span>
				{!running && failedRetryable.length > 0 && (
					<button
						type="button"
						onClick={() => uploadActions.retryFailed()}
						className="shrink-0 rounded px-1.5 py-0.5 text-xs text-th-accent hover:bg-th-accent/10"
					>
						Retry failed
					</button>
				)}
				<button
					type="button"
					onClick={() => setIsExpanded((expanded) => !expanded)}
					aria-expanded={isExpanded}
					aria-label={
						isExpanded ? "Collapse upload queue" : "Expand upload queue"
					}
					className="flex size-9 shrink-0 items-center justify-center rounded-full text-th-text-muted pointer-coarse:size-11 transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary"
				>
					{isExpanded ? (
						<ChevronDown className="h-4 w-4" aria-hidden="true" />
					) : (
						<ChevronUp className="h-4 w-4" aria-hidden="true" />
					)}
				</button>
				<button
					type="button"
					// Cancelling loses nothing that was not going to be re-sent anyway,
					// so it does not ask twice.
					onClick={() =>
						running ? uploadActions.cancelAll() : uploadActions.dismiss()
					}
					aria-label={closeLabel}
					title={closeLabel}
					className="flex size-9 shrink-0 items-center justify-center rounded-full text-th-text-muted pointer-coarse:size-11 transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary"
				>
					<X className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>

			{isExpanded && (
				<ul className="max-h-[12rem] overflow-auto border-t border-th-border">
					{items.map((item) => (
						<UploadRow
							key={item.id}
							item={item}
							onReplace={onReplace}
							onKeepBoth={onKeepBoth}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

export default UploadQueue;
