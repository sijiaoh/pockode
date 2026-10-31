export type CanvasSessionView = "canvas" | "chat";

const VIEWS: readonly { value: CanvasSessionView; label: string }[] = [
	{ value: "canvas", label: "Canvas" },
	{ value: "chat", label: "Chat" },
];

/**
 * The session header's **Canvas | Chat** switch (docs/canvas-ui.md §2). It
 * holds no state: which view is up is the session screen's.
 *
 * Header-sized where `ui/SegmentedControl` is page-wide: the segments stand
 * on the header's 44px row under a thumb, so they are the row's height there
 * and a gap apart rather than sharing one padded track.
 */
export function CanvasViewSwitch({
	view,
	onSelect,
}: {
	view: CanvasSessionView;
	onSelect: (view: CanvasSessionView) => void;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this switches views
		<div
			role="group"
			aria-label="View"
			className="flex shrink-0 items-center gap-1 pointer-coarse:gap-2"
		>
			{VIEWS.map((item) => (
				<button
					key={item.value}
					type="button"
					aria-pressed={view === item.value}
					onClick={() => onSelect(item.value)}
					className={`h-9 rounded-md px-2.5 text-sm transition-colors pointer-coarse:h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
						view === item.value
							? "bg-th-bg-tertiary font-medium text-th-text-primary"
							: "text-th-text-muted hover:text-th-text-primary"
					}`}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}
