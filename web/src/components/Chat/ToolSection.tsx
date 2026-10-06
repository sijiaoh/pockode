import { ChevronRight, ChevronsDownUp } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import {
	BlockHeader,
	type ClampBudget,
	type ClampCount,
	ClampedContent,
	type ClampHandle,
	CollapsibleBody,
	HeaderCopyButton,
} from "../ui";
import { useTranscriptView } from "./transcriptViewContext";
import { useStuckBar } from "./useStuckBar";

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
	/**
	 * How tall the block may be before it is cut (`ClampBudget`): `main` for
	 * what the body is opened for, `supporting` for what explains it. `none` for
	 * what is never cut — a checklist whose every item is the point.
	 */
	budget?: ClampBudget | "none";
	/** See `ClampedContent`. */
	clampFrom?: "start" | "end";
	/** See `ClampedContent`. */
	count?: ClampCount;
	/** See `ClampedContent`. */
	fullScreenTitle?: string;
	/** See `ClampedContent`. */
	follow?: boolean;
}

/**
 * One labelled block of a tool call's body: a header that names it and holds
 * what can be done with it, over content cut to a height the transcript can
 * scroll past.
 *
 * Opened past its budget, the block is the one thing being read, and its
 * header sticks under the row's pinned title with a way to close it again
 * (docs/tool-call-ui.md#the-pinned-section-header): a reader several screens
 * into an output still sees which block it is, and can put it away without
 * scrolling back to either of its buttons.
 */
export function Section({
	label,
	children,
	meta,
	actions,
	copyText,
	copyLabel,
	collapsible,
	budget = "supporting",
	clampFrom,
	count,
	fullScreenTitle,
	follow,
}: Props) {
	const view = useTranscriptView();
	const headerRef = useRef<HTMLDivElement>(null);
	const clampRef = useRef<ClampHandle>(null);
	const boxId = useId();
	const [open, setOpen] = useState(collapsible?.defaultOpen ?? true);
	// Past its budget, that is: the clamp says so only once it has cut.
	const [clampOpen, setClampOpen] = useState(false);
	const pinned = clampOpen && open;
	useStuckBar(headerRef, pinned);
	const name = label.toLowerCase();

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
				(actions || copyText || pinned) && (
					<>
						{actions}
						{copyText && (
							<HeaderCopyButton
								text={copyText}
								label={copyLabel ?? `Copy ${name}`}
							/>
						)}
						{pinned && (
							<button
								type="button"
								onClick={() => clampRef.current?.close()}
								aria-expanded
								aria-controls={boxId}
								// The clamp's own button's name: the two do the same.
								aria-label={`Show less of ${name}`}
								className="touch-target flex size-6 items-center justify-center rounded text-th-text-muted hover:bg-th-overlay-hover hover:text-th-text-primary"
							>
								<ChevronsDownUp size={14} aria-hidden="true" />
							</button>
						)}
					</>
				)
			}
		/>
	);

	const body =
		budget === "none" ? (
			children
		) : (
			<ClampedContent
				budget={budget}
				from={clampFrom}
				count={count}
				name={name}
				fullScreenTitle={fullScreenTitle}
				view={view}
				landingRef={headerRef}
				id={boxId}
				ref={clampRef}
				onOpenChange={setClampOpen}
				follow={follow}
			>
				{children}
			</ClampedContent>
		);

	return (
		<div
			// A foldable title's hit area reaches 10px above the header under a
			// thumb, as does a cut section's button below its content, and the
			// body's 12px between sections cannot hold both: the title is moved
			// clear (docs/responsive-ui.md, the overlay's two checks).
			className={`tool-section ${collapsible ? "pointer-coarse:pt-2.5" : ""}`}
		>
			{/* The gap to the body is the header's padding, not a margin: a
			    pinned header keeps its margin inside the section, and the
			    section's last line would show under it as it is carried off. */}
			<div ref={headerRef} className={`pb-1 ${pinned ? "section-bar" : ""}`}>
				{header}
			</div>
			{collapsible ? (
				<CollapsibleBody expanded={open}>{body}</CollapsibleBody>
			) : (
				body
			)}
		</div>
	);
}
