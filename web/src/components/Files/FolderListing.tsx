import { linkDescription, opensAt } from "../../lib/symlink";
import type { Entry } from "../../types/contents";
import { EntryIcon, LinkStatusGlyph } from "./EntryIcon";

interface Props {
	entries: Entry[];
	onOpen: (path: string) => void;
}

/**
 * A folder opened in the viewer — a directory link followed from a chat path,
 * or any folder's URL — as a plain list of what is in it, rather than nothing
 * (docs/symlinks.md#viewer). Each row opens in the viewer, a folder as another
 * listing.
 */
function FolderListing({ entries, onOpen }: Props) {
	if (entries.length === 0) {
		return (
			<div className="px-6 py-10 text-center text-sm text-th-text-muted">
				This folder is empty
			</div>
		);
	}

	return (
		<ul className="py-1">
			{entries.map((entry) => {
				const name = entry.link
					? linkDescription(entry.name, entry.link)
					: entry.name;
				return (
					<li key={entry.path}>
						<button
							type="button"
							onClick={() => onOpen(opensAt(entry.path, entry.link))}
							aria-label={`Open: ${name}`}
							title={entry.link ? name : undefined}
							className="flex min-h-[44px] w-full items-center gap-2 px-4 text-left text-sm text-th-text-secondary transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset"
						>
							<EntryIcon type={entry.type} link={entry.link} />
							<span
								className={`truncate ${entry.type === "link" ? "text-th-text-muted" : ""}`}
							>
								{entry.name}
							</span>
							<LinkStatusGlyph link={entry.link} />
						</button>
					</li>
				);
			})}
		</ul>
	);
}

export default FolderListing;
