import { AlertTriangle } from "lucide-react";
import type {
	Frontmatter,
	FrontmatterEntry,
	FrontmatterValue,
} from "../../lib/frontmatter";

interface Props {
	frontmatter: Frontmatter;
}

// Border only, no fill: tool-result drawers already sit on a secondary
// background a filled card would vanish into, and a fill would read as a
// code block.
const FRAME = "rounded-lg border border-th-border text-sm leading-normal";
// The key column is as wide as the longest key, capped so a long key cannot
// squeeze the values on a phone.
const GRID = "grid grid-cols-[fit-content(min(40%,16rem))_minmax(0,1fr)]";

/** A Markdown file's frontmatter, shown as the file's properties. */
export function FrontmatterBlock({ frontmatter }: Props) {
	if (frontmatter.state === "invalid") {
		return (
			<div className={FRAME}>
				<div className="flex gap-1.5 border-th-border border-b px-3 py-1.5 text-th-text-muted text-xs">
					<AlertTriangle
						aria-hidden="true"
						className="mt-px size-3.5 shrink-0 text-th-warning"
					/>
					<div className="min-w-0">
						<p className="text-th-text-secondary">
							{frontmatter.reason === "syntax"
								? "Frontmatter could not be parsed as YAML"
								: "Frontmatter is not a set of properties"}
						</p>
						{frontmatter.message && (
							<p className="[overflow-wrap:anywhere]">{frontmatter.message}</p>
						)}
					</div>
				</div>
				<pre className="whitespace-pre-wrap px-3 py-2 font-mono text-th-text-secondary text-xs [overflow-wrap:anywhere]">
					{frontmatter.raw}
				</pre>
			</div>
		);
	}

	return (
		<div className={FRAME}>
			<Properties entries={frontmatter.entries} top />
		</div>
	);
}

function Properties({
	entries,
	top = false,
}: {
	entries: FrontmatterEntry[];
	top?: boolean;
}) {
	return (
		<dl className={`${GRID} ${top ? "gap-x-4 px-3" : "gap-x-3"}`}>
			{entries.map((entry, i) => (
				<Row
					// biome-ignore lint/suspicious/noArrayIndexKey: `1` and `"1"` are distinct keys with the same text
					key={i}
					entry={entry}
					top={top}
				/>
			))}
		</dl>
	);
}

function isBlock(value: FrontmatterValue): boolean {
	return value.kind === "map" || value.kind === "list";
}

function Row({ entry, top }: { entry: FrontmatterEntry; top: boolean }) {
	const rowClass = top
		? "py-1.5 border-th-border border-t first:border-t-0"
		: "py-0.5";
	const key = (
		<dt className="text-th-text-muted [overflow-wrap:anywhere]">{entry.key}</dt>
	);

	// A structured value goes under its key rather than beside it: each nested
	// level then costs an indent instead of another key column.
	if (isBlock(entry.value)) {
		return (
			<div className={`col-span-2 ${rowClass}`}>
				{key}
				<dd className="mt-0.5 min-w-0 border-th-border border-l pl-2.5">
					<Value value={entry.value} />
				</dd>
			</div>
		);
	}

	return (
		<div className={`col-span-2 grid grid-cols-subgrid ${rowClass}`}>
			{key}
			<dd className="min-w-0 whitespace-pre-wrap text-th-text-primary [overflow-wrap:anywhere]">
				<Value value={entry.value} />
			</dd>
		</div>
	);
}

// Values are React text nodes only: `**x**` and `<b>` show as written.
function Value({ value }: { value: FrontmatterValue }) {
	switch (value.kind) {
		case "text":
			return value.text;
		case "literal":
			return (
				<span className="font-mono text-[0.9em] text-th-code-text">
					{value.text}
				</span>
			);
		case "empty":
			return (
				<>
					<span aria-hidden="true" className="text-th-text-muted">
						—
					</span>
					<span className="sr-only">empty</span>
				</>
			);
		case "chips":
			return (
				<span className="flex flex-wrap gap-1">
					{value.items.map((item, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their position
							key={i}
							className="max-w-full rounded bg-th-bg-tertiary px-1.5"
						>
							<Value value={item} />
						</span>
					))}
				</span>
			);
		case "map":
			return <Properties entries={value.entries} />;
		case "list":
			return (
				<div className="divide-y divide-th-border">
					{value.items.map((item, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their position
							key={i}
							className="min-w-0 whitespace-pre-wrap py-1 text-th-text-primary [overflow-wrap:anywhere]"
						>
							<Value value={item} />
						</div>
					))}
				</div>
			);
		case "source":
			return (
				<span className="block whitespace-pre-wrap font-mono text-th-text-secondary text-xs [overflow-wrap:anywhere]">
					{value.text}
				</span>
			);
	}
}
