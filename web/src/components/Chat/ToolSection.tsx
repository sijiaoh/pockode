import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	BlockHeader,
	ClampedContent,
	CollapsibleBody,
	HeaderCopyButton,
} from "../ui";

interface Props {
	label: string;
	children: ReactNode;
	/** Beside the label: a count, a state — what the block holds at a glance. */
	meta?: ReactNode;
	/** Header controls besides copying, ahead of the copy button. */
	actions?: ReactNode;
	/** What the header's copy button copies; no button without it. */
	copyText?: string | (() => string);
	/** The copy button's name, where `Copy <label>` would not read as one. */
	copyLabel?: string;
	/**
	 * Fold the block under its header, open or closed to begin with. For what the
	 * row has already said — the input of a `Read` whose path is the row's whole
	 * detail — and is in the body only so that it is somewhere in full.
	 */
	collapsible?: { defaultOpen: boolean };
	/** See `ClampedContent`. */
	clampFrom?: "start" | "end";
	/** See `ClampedContent`. */
	fullScreenTitle?: string;
	/** See `ClampedContent`. */
	showAllLabel?: string;
}

/**
 * One labelled block of a tool call's body: a header that names it and holds
 * what can be done with it, over content cut to a height the transcript can
 * scroll past.
 */
export function Section({
	label,
	children,
	meta,
	actions,
	copyText,
	copyLabel,
	collapsible,
	clampFrom,
	fullScreenTitle,
	showAllLabel,
}: Props) {
	const [open, setOpen] = useState(collapsible?.defaultOpen ?? true);

	const title = collapsible ? (
		<button
			type="button"
			aria-expanded={open}
			onClick={() => setOpen(!open)}
			className="touch-target flex min-w-0 items-center gap-1.5 rounded text-left hover:text-th-text-primary"
		>
			<ChevronRight
				className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
				aria-hidden="true"
			/>
			<span className="truncate">{label}</span>
		</button>
	) : (
		<span className="truncate">{label}</span>
	);

	const header = (
		<BlockHeader
			label={
				meta ? (
					<>
						{title}
						<span className="ml-2 shrink-0">{meta}</span>
					</>
				) : (
					title
				)
			}
			actions={
				(actions || copyText) && (
					<>
						{actions}
						{copyText && (
							<HeaderCopyButton
								text={copyText}
								label={copyLabel ?? `Copy ${label.toLowerCase()}`}
							/>
						)}
					</>
				)
			}
		/>
	);

	const body = (
		<ClampedContent
			from={clampFrom}
			fullScreenTitle={fullScreenTitle}
			showAllLabel={showAllLabel}
		>
			{children}
		</ClampedContent>
	);

	return (
		<div className="space-y-1">
			{header}
			{collapsible ? (
				<CollapsibleBody expanded={open}>{body}</CollapsibleBody>
			) : (
				body
			)}
		</div>
	);
}
