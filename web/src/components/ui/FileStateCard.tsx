import type { LucideIcon } from "lucide-react";

interface Detail {
	label: string;
	value: string;
}

interface Props {
	icon: LucideIcon;
	iconClassName?: string;
	title: string;
	description?: string;
	details?: Detail[];
	footnote?: string;
	action?: { label: string; onClick: () => void };
}

/**
 * Placeholder shown in place of file content the viewer cannot render.
 *
 * Reuses the empty-state language of the file search results so "nothing to
 * show here" looks the same everywhere in the Files tab.
 */
export function FileStateCard({
	icon: Icon,
	iconClassName = "text-th-text-muted",
	title,
	description,
	details,
	footnote,
	action,
}: Props) {
	return (
		<div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
			<Icon className={`h-8 w-8 ${iconClassName}`} aria-hidden="true" />
			<div className="text-sm text-th-text-primary">{title}</div>
			{description && (
				<div className="text-sm text-th-text-muted">{description}</div>
			)}
			{details && details.length > 0 && (
				<dl className="w-full max-w-sm rounded-lg border border-th-border bg-th-bg-secondary px-3 py-2 text-left text-xs">
					{details.map(({ label, value }) => (
						<div key={label} className="flex gap-3 py-0.5">
							<dt className="w-10 shrink-0 text-th-text-muted">{label}</dt>
							{/* Long MIME types would otherwise push the card past a phone screen. */}
							<dd className="min-w-0 break-all text-th-text-secondary">
								{value}
							</dd>
						</div>
					))}
				</dl>
			)}
			{footnote && <div className="text-xs text-th-text-muted">{footnote}</div>}
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					className="min-h-[44px] rounded-lg bg-th-bg-tertiary px-4 text-sm text-th-text-primary transition-colors hover:bg-th-bg-secondary"
				>
					{action.label}
				</button>
			)}
		</div>
	);
}
