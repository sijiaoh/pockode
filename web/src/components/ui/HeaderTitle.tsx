import type { ReactNode } from "react";
import { splitExtension } from "../../utils/path";

export const headerSkeletonClass = "animate-pulse rounded bg-th-text-muted/20";

/**
 * The box around a heading's two lines, shared by the session's heading and a
 * page's so the two read as one header. The padding stays when the box does
 * nothing on press, so every page's text starts on the same vertical line and
 * moving between one that can be pressed and one that cannot does not shift it.
 */
export const headerTitleBoxClass =
	"flex h-11 min-w-0 flex-1 flex-col items-start justify-center rounded px-2 text-left sm:h-12";

/**
 * Added to the box when it is a button. No `active:scale-95`: two lines of text
 * shrinking together reads as a wobble, and scaling is left to the icons.
 * `active:` is for a thumb, which never hovers.
 */
export const headerTitlePressableClass =
	"transition-colors hover:bg-th-bg-tertiary active:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";

export const headerTitleTextClass =
	"truncate text-sm font-semibold text-th-text-primary";

interface LinesProps {
	/** `null` while it has not arrived: a skeleton, never a stand-in title. */
	title: ReactNode | null;
	/**
	 * `null` while it has not arrived, absent when the page has none — then the
	 * title alone is centred rather than leaving an empty line under it.
	 */
	subtitle?: ReactNode | null;
	/**
	 * Drawn right after the title, and only when the box can be pressed: a
	 * chevron here is the one sign that it can, and its direction says where
	 * pressing goes.
	 */
	hint?: ReactNode;
}

/**
 * A heading's two lines: the title, and under it what the title is not enough
 * to say. Each line waits on its own data, so a line that is already known is
 * shown while the other is still a skeleton.
 */
export function HeaderTitleLines({ title, subtitle, hint }: LinesProps) {
	return (
		<>
			<span className="flex max-w-full min-w-0 items-center gap-1">
				{title === null ? (
					<span
						aria-hidden="true"
						className={`h-3.5 w-28 ${headerSkeletonClass}`}
					/>
				) : (
					title
				)}
				{hint}
			</span>
			{subtitle === null ? (
				<span
					aria-hidden="true"
					className={`mt-1 h-3 w-20 ${headerSkeletonClass}`}
				/>
			) : (
				subtitle !== undefined && (
					<span className="flex max-w-full min-w-0 items-center text-xs text-th-text-muted">
						{/* Lines are flex boxes, which an accessible name runs
						    together; this keeps the two from reading as one word. */}
						<span className="sr-only">, </span>
						{subtitle}
					</span>
				)
			)}
		</>
	);
}

/**
 * A file name as a heading's title. The stem truncates and the extension stays,
 * so a name cut short still says what kind of file it is.
 */
export function FileNameTitle({ name }: { name: string }) {
	const { stem, extension } = splitExtension(name);
	return (
		<span className="flex min-w-0 text-sm font-semibold text-th-text-primary">
			<span className="min-w-0 truncate">{stem}</span>
			{extension && <span className="shrink-0">{extension}</span>}
		</span>
	);
}

interface SubtitleProps {
	/** Gives way first — a directory, say. */
	detail?: string;
	/**
	 * Which version or state of the thing this is (`Staged`, `Editing`, a short
	 * hash). Kept whole, and a shade darker than the detail so it is found at a
	 * glance; neutral rather than coloured, since colour on a page is left to the
	 * actions that change it.
	 */
	status?: string;
	/** For a hash. */
	mono?: boolean;
}

/** A page's second line: something that may be cut, then something that may not. */
export function HeaderSubtitle({
	detail,
	status,
	mono = false,
}: SubtitleProps) {
	return (
		<>
			{detail && <span className="min-w-0 truncate">{detail}</span>}
			{detail && status && <span className="shrink-0 px-1">·</span>}
			{status && (
				<span
					className={`shrink-0 text-th-text-secondary ${mono ? "font-mono" : ""}`}
				>
					{status}
				</span>
			)}
		</>
	);
}
