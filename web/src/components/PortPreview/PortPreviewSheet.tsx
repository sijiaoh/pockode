import { useHasCoarsePointer } from "@pockode/shared";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { openInNewTab, parsePort, previewUrl } from "../../lib/portPreview";
import {
	portPreviewActions,
	usePortPreviewStore,
} from "../../lib/portPreviewStore";
import { iconButtonClass, Sheet } from "../ui";
import { inputClass } from "../ui/inputClass";

interface Props {
	remoteUrl: string;
	onClose: () => void;
}

function PortPreviewSheet({ remoteUrl, onClose }: Props) {
	const recentPorts = usePortPreviewStore((s) => s.recentPorts);
	const isPrimaryPointerCoarse = useHasCoarsePointer();
	const [input, setInput] = useState("");
	// Blocked attempts since the input last changed.
	const [blockedCount, setBlockedCount] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const inputId = useId();
	const helpId = useId();
	const recentTitleId = useId();

	// Under a thumb with recent ports, the keyboard would cover the list, and
	// tapping a row there is the likeliest next move. Read once, on open.
	const focusInputRef = useRef(
		!(isPrimaryPointerCoarse && recentPorts.length > 0),
	);
	useEffect(() => {
		if (focusInputRef.current) inputRef.current?.focus();
	}, []);

	const port = parsePort(input);
	const url = port === null ? null : previewUrl(remoteUrl, port);
	const invalid = input.trim() !== "" && port === null;

	// Synchronous throughout: an await before opening would cost the user
	// activation, and the browser would block the tab.
	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (port === null || url === null) return;
		// Recorded before opening, so a blocked tab leaves a link in Recent —
		// and a link click is never blocked.
		portPreviewActions.recordPort(port);
		if (openInNewTab(url)) {
			onClose();
		} else {
			setBlockedCount((n) => n + 1);
		}
	};

	// The removed row takes its focused button with it, which would drop focus
	// to the body, outside the sheet's focus trap. Hand it to the row now in
	// that place, or the one before, or the input once the list is gone.
	const handleRemove = (index: number) => {
		flushSync(() => portPreviewActions.removePort(recentPorts[index]));
		const buttons = listRef.current?.querySelectorAll("button");
		const next = buttons?.[Math.min(index, buttons.length - 1)];
		(next ?? inputRef.current)?.focus();
	};

	return (
		<Sheet
			title="Preview a Port"
			onClose={onClose}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						className="flex-1 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90"
					>
						Cancel
					</button>
					<button
						type="submit"
						className="flex-1 rounded-lg bg-th-accent px-4 py-2.5 text-sm text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
						disabled={port === null}
					>
						Open
					</button>
				</>
			}
		>
			<div className="space-y-4 p-4">
				<div className="space-y-1.5">
					<label htmlFor={inputId} className="text-sm text-th-text-primary">
						Port
					</label>
					{/* Not type="number": it brings a spinner, the scroll wheel changes
					    it and it accepts `e`, `-` and `.`. No maxLength or pattern
					    either, so `parsePort` is the only rule: maxLength silently cuts
					    a pasted `http://localhost:5173` to `http:`, and pattern makes
					    the browser refuse a pasted `5173 ` that `parsePort` accepts. */}
					<input
						ref={inputRef}
						id={inputId}
						type="text"
						inputMode="numeric"
						enterKeyHint="go"
						autoComplete="off"
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							setBlockedCount(0);
						}}
						placeholder="5173"
						aria-describedby={helpId}
						aria-invalid={invalid}
						className={`w-full rounded-lg bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
					/>
					{/* No aria-live: it would read the address out on every keystroke.
					    Only the blocked tab, which follows a submit, is announced —
					    keyed per attempt so each one mounts as a new alert, rather than
					    React reusing the previous line, which screen readers may not
					    announce again. */}
					{blockedCount > 0 ? (
						<p
							key={`blocked-${blockedCount}`}
							id={helpId}
							role="alert"
							className="text-xs text-th-error"
						>
							The browser blocked the new tab. Open it from Recent below.
						</p>
					) : invalid ? (
						<p id={helpId} className="text-xs text-th-error">
							Enter a port from 1 to 65535
						</p>
					) : url ? (
						<p id={helpId} className="truncate text-xs text-th-text-muted">
							Opens {new URL(url).host}
						</p>
					) : (
						<p id={helpId} className="text-xs text-th-text-muted">
							The port your dev server is listening on, like 5173 for Vite
						</p>
					)}
				</div>

				{recentPorts.length > 0 && (
					<section aria-labelledby={recentTitleId}>
						<h3
							id={recentTitleId}
							className="pb-1 text-[11px] font-medium uppercase tracking-wide text-th-text-muted"
						>
							Recent
						</h3>
						<ul ref={listRef}>
							{recentPorts.map((recent, index) => (
								<RecentPortRow
									key={recent}
									port={recent}
									href={previewUrl(remoteUrl, recent)}
									onOpen={onClose}
									onRemove={() => handleRemove(index)}
								/>
							))}
						</ul>
					</section>
				)}

				<p className="text-xs text-th-text-muted">
					The first visit to each port asks for your Pockode password.
				</p>
			</div>
		</Sheet>
	);
}

/**
 * A native link rather than a button calling `window.open`: a link click is
 * never blocked, and it keeps long-press and middle-click. The remove button
 * is its sibling, since interactive elements must not nest.
 */
function RecentPortRow({
	port,
	href,
	onOpen,
	onRemove,
}: {
	port: number;
	href: string;
	onOpen: () => void;
	onRemove: () => void;
}) {
	const label = `localhost:${port}`;

	return (
		<li className="group flex items-center gap-2">
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				onClick={() => {
					portPreviewActions.recordPort(port);
					onOpen();
				}}
				className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 -ml-2 rounded-md px-2 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			>
				<span className="truncate">{label}</span>
				<ExternalLink
					className="size-4 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
			</a>
			{/* No confirmation: typing the port again brings it back. Revealed on
			    hover for a fine pointer only, as `DeleteButton` does. */}
			<button
				type="button"
				onClick={onRemove}
				className={`${iconButtonClass()} -mr-2 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100`}
				aria-label={`Remove ${label} from recent`}
			>
				<X className="size-4" aria-hidden="true" />
			</button>
		</li>
	);
}

export default PortPreviewSheet;
