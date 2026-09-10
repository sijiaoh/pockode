import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
import { iconButtonClass } from "../common/iconButtonClass";
import GitOutput from "./GitOutput";

interface Props {
	/** One line of plain language: what failed. */
	summary: string;
	/** git's own output, shown verbatim behind the disclosure. */
	details: string;
	onDismiss: () => void;
}

/**
 * Where an inline action reports its failure.
 *
 * Sheets keep their errors inside themselves, but discard has no sheet to hold
 * the outcome, so the panel carries a banner under the branch bar instead. The
 * summary does not replace git's text: the reader is a developer who needs the
 * path git could not write, not a paraphrase of it.
 */
function ErrorBanner({ summary, details, onDismiss }: Props) {
	const [showDetails, setShowDetails] = useState(false);

	return (
		<div
			role="alert"
			className="flex shrink-0 items-start gap-2 border-b border-th-border bg-th-error/10 px-3 py-2"
		>
			<AlertTriangle
				className="mt-0.5 h-4 w-4 shrink-0 text-th-error"
				aria-hidden="true"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-2 text-sm text-th-error">
					<span className="min-w-0 break-words">{summary}</span>
					{details && (
						<button
							type="button"
							onClick={() => setShowDetails(!showDetails)}
							aria-expanded={showDetails}
							className="text-xs text-th-text-secondary underline transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						>
							Details
						</button>
					)}
				</div>
				{showDetails && details && (
					<div className="mt-1">
						<GitOutput>{details}</GitOutput>
					</div>
				)}
			</div>
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Dismiss error"
				className={iconButtonClass()}
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</div>
	);
}

export default ErrorBanner;
