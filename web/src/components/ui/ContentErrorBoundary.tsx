import { ErrorBoundary } from "@pockode/shared";
import { AlertTriangle } from "lucide-react";
import { type ReactNode, useState } from "react";
import { FileStateCard } from "./FileStateCard";

interface CardProps {
	/** What could not be shown, as the title names it: `a.txt`, "this page". */
	name: string;
	error: Error;
	onRetry: () => void;
	/**
	 * The text the failed view was drawing, offered as it is — for a diff, the
	 * patch — so what failed to render can still be read.
	 */
	raw?: string;
}

/** What a boundary draws in place of what threw. */
export function RenderErrorCard({ name, error, onRetry, raw }: CardProps) {
	const [showRaw, setShowRaw] = useState(false);
	return (
		<div>
			{/* Only the card is the alert: the raw text revealed below would
			    otherwise be read out whole as a live-region change. */}
			<div role="alert">
				<FileStateCard
					icon={AlertTriangle}
					iconClassName="text-th-error"
					title={`Couldn't show ${name}`}
					// A throw may carry no message; its name is still something.
					description={error.message || error.name}
					action={{ label: "Retry", onClick: onRetry }}
				/>
			</div>
			{raw !== undefined && (
				<div className="flex flex-col items-center gap-2 px-3 pb-6">
					<button
						type="button"
						onClick={() => setShowRaw((shown) => !shown)}
						aria-expanded={showRaw}
						className="inline-flex min-h-9 items-center rounded px-2 text-sm text-th-accent hover:underline pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						{showRaw ? "Hide raw" : "Show raw"}
					</button>
					{showRaw && (
						<pre className="w-full overflow-x-auto rounded-lg border border-th-border bg-th-bg-secondary p-3 text-left font-mono text-xs text-th-text-secondary">
							{raw}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

interface Props extends Omit<CardProps, "error" | "onRetry"> {
	children: ReactNode;
	/**
	 * What the children are showing — the path, the patch. A new one draws
	 * them again, so a failure stays with the content that caused it.
	 */
	resetKey: unknown;
}

/**
 * Around a view of content that third-party code renders — a diff parser, a
 * highlighter, a Markdown or diagram renderer — any of which can throw on an
 * input nobody anticipated. The throw then costs that one view: the page
 * around it, the tree and the chat stay where they were.
 *
 * React logs each caught error with its component stack (`onCaughtError`),
 * so the console has more than the one line on screen.
 */
export function ContentErrorBoundary({ children, resetKey, name, raw }: Props) {
	return (
		<ErrorBoundary
			resetKey={resetKey}
			fallback={(error, reset) => (
				<RenderErrorCard name={name} error={error} onRetry={reset} raw={raw} />
			)}
		>
			{children}
		</ErrorBoundary>
	);
}
