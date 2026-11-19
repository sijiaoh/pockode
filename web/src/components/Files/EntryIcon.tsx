import {
	CircleSlash,
	File,
	FileSymlink,
	Folder,
	FolderOpen,
	FolderSymlink,
	Link2,
	Repeat,
	SquareArrowOutUpRight,
	TriangleAlert,
} from "lucide-react";
import { isUnfollowable } from "../../lib/symlink";
import type { EntryType, Link } from "../../types/contents";

interface Props {
	type: EntryType;
	link?: Link;
	/** A folder something is being dropped into. */
	open?: boolean;
	className?: string;
}

/**
 * An entry's icon wherever entries are listed — the tree, name search, a
 * folder opened in the viewer — so a link is marked the same everywhere: its
 * target type's icon with a link arrow, or a bare link for one that cannot be
 * followed (docs/symlinks.md#file-tree).
 */
export function EntryIcon({
	type,
	link,
	open = false,
	className = "h-4 w-4 shrink-0 text-th-text-muted",
}: Props) {
	const Icon =
		type === "link"
			? Link2
			: type === "dir"
				? link
					? FolderSymlink
					: open
						? FolderOpen
						: Folder
				: link
					? FileSymlink
					: File;
	return <Icon className={className} aria-hidden="true" />;
}

const GLYPH = {
	broken: TriangleAlert,
	outside: SquareArrowOutUpRight,
	loop: Repeat,
	unsupported: CircleSlash,
} as const;

/**
 * Trails the name of a link that cannot be followed, saying why at a glance.
 * Decorative: the row's accessible name says it in words (`linkDescription`).
 */
export function LinkStatusGlyph({ link }: { link?: Link }) {
	if (!link || !isUnfollowable(link.state)) return null;
	const Glyph = GLYPH[link.state];
	return (
		<Glyph
			className="h-3.5 w-3.5 shrink-0 text-th-text-muted"
			aria-hidden="true"
		/>
	);
}
