import { type ReactNode, useRef } from "react";

/**
 * Tracks whether a collapsible region has ever been open. Not to be confused
 * with `useIsExpanded`, which reports the viewport's width tier.
 *
 * Use it to gate work that only the expanded body needs — pretty-printing JSON,
 * building a diff — so a collapsed region never pays for content nobody asked
 * to see. Once true it stays true, which is what keeps the expanded body from
 * recomputing every time it is collapsed and reopened.
 */
export function useEverExpanded(expanded: boolean): boolean {
	const everExpanded = useRef(false);
	if (expanded) everExpanded.current = true;
	return everExpanded.current;
}

interface Props {
	expanded: boolean;
	children: ReactNode;
}

/**
 * The body of a collapsible region, rendered on demand.
 *
 * Nothing inside exists until the region is first expanded, so a collapsed tool
 * result costs no diff, no syntax highlighting and no Markdown pass. After that
 * the subtree stays mounted and is merely hidden, so reopening is free and the
 * body keeps its own React state — nested expansions, form input, a rendered
 * diagram. Not its scroll position: `hidden` is `display: none`, which destroys
 * the scrolling box and resets it.
 *
 * The wrapper element carries no styling of its own; it exists only to hold the
 * `hidden` attribute, and is transparent to the block layout of every caller.
 */
export function CollapsibleBody({ expanded, children }: Props) {
	const everExpanded = useEverExpanded(expanded);
	if (!everExpanded) return null;

	return <div hidden={!expanded}>{children}</div>;
}
