import type { Entry, Link, LinkState } from "../types/contents";

/*
 * How a symlink is presented, for every surface that lists or opens one
 * (docs/symlinks.md#surfaces). The server classifies; nothing here works out
 * where a link leads.
 */

/** The states a link cannot be followed in; each gets a link page. */
export type UnfollowableState = Exclude<LinkState, "ok" | "cycle">;

/**
 * Whether the row is a folder that expands where it is listed. A cycle is
 * typed as a directory but never expanded in place: following it would nest
 * the same folders forever (docs/symlinks.md#cycles).
 */
export function opensInPlace(entry: Pick<Entry, "type" | "link">): boolean {
	return entry.type === "dir" && entry.link?.state !== "cycle";
}

/**
 * Where "Reveal target" goes: the project-relative real path, for the states
 * that have one. Null for the project root (`self -> .`), which has no row or
 * page of its own to reveal.
 */
export function revealPath(link: Link): string | null {
	return link.resolved ? link.resolved : null;
}

/** How a state is named after the link's name, for a row's label. */
const STATUS: Record<UnfollowableState, string> = {
	broken: "broken link",
	loop: "link loop",
	outside: "link outside the project",
	unsupported: "not a file or folder",
};

const PAGE: Record<UnfollowableState, { title: string; explanation: string }> =
	{
		broken: {
			title: "Broken link",
			explanation: "Nothing is at the path it points to.",
		},
		loop: {
			title: "Link loop",
			explanation:
				"It leads back to itself, so it never reaches a file or folder.",
		},
		outside: {
			title: "Link outside the project",
			explanation:
				"Pockode only opens files inside the project. Ask the agent if you need what it points to.",
		},
		unsupported: {
			title: "Not a file or folder",
			explanation:
				"It points to something else in the project, such as a pipe or a device, which cannot be opened here.",
		},
	};

export function isUnfollowable(state: LinkState): state is UnfollowableState {
	return state !== "ok" && state !== "cycle";
}

/** What the link page says for a link that cannot be followed. */
export function linkPageCopy(state: UnfollowableState) {
	return PAGE[state];
}

/**
 * A link row's name for a screen reader and its tooltip: `skills, link to
 * ../.agent-skills`, and why it cannot be followed when it cannot.
 */
export function linkDescription(name: string, link: Link): string {
	const base = `${name}, link to ${link.target}`;
	return isUnfollowable(link.state) ? `${base} (${STATUS[link.state]})` : base;
}

/**
 * The delete confirmation's words for a link, wherever it is deleted from:
 * deleting removes the link alone, and the dialog says so, since "this will
 * delete skills" reads as the folder going too.
 */
export function deleteLinkMessage(entry: Pick<Entry, "name" | "type">): string {
	const what =
		entry.type === "dir"
			? "The folder it points to"
			: entry.type === "file"
				? "The file it points to"
				: "What it points to";
	return `Delete the link "${entry.name}"? ${what} is not affected.`;
}

/**
 * Where tapping an entry goes. A cycle opens where it really is, since it is
 * never expanded in place; a link to the project root has no page of its own,
 * so it opens as written, which lists the root — a finite path.
 */
export function opensAt(path: string, link?: Link): string {
	return link?.state === "cycle" ? link.resolved || path : path;
}
