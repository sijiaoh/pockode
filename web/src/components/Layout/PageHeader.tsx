import { ArrowLeft, ChevronRight, MessageSquare } from "lucide-react";
import {
	createContext,
	type ReactNode,
	type Ref,
	useCallback,
	useContext,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useOpenSessionUnread } from "../../hooks/useOpenSessionUnread";
import { splitPath } from "../../utils/path";
import BadgeDot from "../ui/BadgeDot";
import {
	FileNameTitle,
	HeaderSubtitle,
	HeaderTitleLines,
	headerSkeletonClass,
	headerTitleBoxClass,
	headerTitlePressableClass,
	headerTitleTextClass,
} from "../ui/HeaderTitle";
import { headerIconButtonClass } from "../ui/headerIconButtonClass";

/**
 * Where a page's way back leads. `chat` is a page opened over the conversation,
 * and closing it returns there; `parent` is a page opened from another page.
 */
export type PageBack =
	| { to: "chat"; onClick: () => void }
	| { to: "parent"; label: string; onClick: () => void };

interface Props {
	/** `null` while it cannot be known yet: a placeholder of the same size. */
	back: PageBack | null;
	/**
	 * A string is drawn as a title; pass `FileNameTitle` for a file name, so its
	 * extension survives truncation. `null` while it has not arrived.
	 */
	title: ReactNode | null;
	/** See `HeaderTitleLines`: `null` is loading, absent is none. */
	subtitle?: ReactNode | null;
	/**
	 * Everything the two lines may cut, for the `title` tooltip — the full path,
	 * the full subject. Screen readers already get the whole text.
	 */
	fullText?: string;
	/** Makes the title a button, which then needs `titleActionLabel`. */
	onTitleClick?: () => void;
	titleActionLabel?: string;
}

interface Target {
	element: HTMLElement | null;
	claim: () => () => void;
}

/**
 * Undefined outside a host: a page rendered on its own (a unit test) draws its
 * heading where it stands rather than nowhere.
 */
const TargetContext = createContext<Target | undefined>(undefined);

/**
 * Lays out the way back and the heading as the header's own: `first:-ml-2`
 * puts the back button's icon on the header's padding line when no menu button
 * is ahead of it, as the menu button does when it is.
 */
const outletClass = "flex min-w-0 flex-1 items-center gap-2 first:-ml-2";

/**
 * Hosts the heading of whichever page is open, in the app header.
 *
 * The page owns its title and its way back — they come from its own data —
 * while the header is drawn by `MainContainer` above it; this is the bridge.
 * Render `outlet` as the header's `heading` while `claimed`, and wrap the page
 * in `PageHeaderTarget` with `target`. `claimed` is false until a page draws a
 * `PageHeader`, so the header has something to show over a page that does not
 * (yet) draw one.
 */
export function usePageHeaderHost() {
	const [element, setElement] = useState<HTMLElement | null>(null);
	const [claims, setClaims] = useState(0);
	const claim = useCallback(() => {
		setClaims((n) => n + 1);
		return () => setClaims((n) => n - 1);
	}, []);
	const target = useMemo(() => ({ element, claim }), [element, claim]);
	return {
		claimed: claims > 0,
		outlet: <PageHeaderOutlet ref={setElement} />,
		target,
	};
}

/** Wraps the page, handing it `usePageHeaderHost().target`. */
export function PageHeaderTarget({
	value,
	children,
}: {
	value: Target;
	children: ReactNode;
}) {
	return <TargetContext value={value}>{children}</TargetContext>;
}

function PageHeaderOutlet({ ref }: { ref: Ref<HTMLDivElement> }) {
	return <div ref={ref} className={outletClass} />;
}

/**
 * A page's heading — its way back, its title and the line under it — drawn in
 * the app header when the page is hosted (`usePageHeaderHost`), and as a bar
 * of its own at the top of the page when it is not.
 */
export default function PageHeader(props: Props) {
	const target = useContext(TargetContext);
	const claim = target?.claim;
	// A layout effect, so the header swaps to the outlet before the first paint
	// rather than showing whatever stood there for a frame.
	useLayoutEffect(() => claim?.(), [claim]);

	const content = <PageHeading {...props} />;
	if (target === undefined) {
		return (
			<div className="flex h-11 shrink-0 items-center border-b border-th-border px-3 sm:h-12 sm:px-4">
				<div className={outletClass}>{content}</div>
			</div>
		);
	}
	return target.element ? createPortal(content, target.element) : null;
}

interface FileProps extends Pick<Props, "back" | "onTitleClick"> {
	path: string;
	/** Which version or state of the file this page shows; see `HeaderSubtitle`. */
	status?: string;
	/** For a hash. */
	mono?: boolean;
	/** Defaults to `Open <file name>`. */
	titleActionLabel?: string;
}

/**
 * The heading of a page about one file: its name as the title, and its folder
 * and `status` under it. A file at the root with no status has a title alone.
 */
export function FilePageHeader({
	path,
	status,
	mono,
	back,
	onTitleClick,
	titleActionLabel,
}: FileProps) {
	const { fileName, directory: withSlash } = splitPath(path);
	// The `·` after it already ends the folder; a trailing slash would be a
	// second separator.
	const directory = withSlash.replace(/\/$/, "");
	return (
		<PageHeader
			back={back}
			title={<FileNameTitle name={fileName} />}
			subtitle={
				directory || status ? (
					<HeaderSubtitle detail={directory} status={status} mono={mono} />
				) : undefined
			}
			fullText={status ? `${path} — ${status}` : path}
			onTitleClick={onTitleClick}
			titleActionLabel={
				onTitleClick && (titleActionLabel ?? `Open ${fileName}`)
			}
		/>
	);
}

function PageHeading({
	back,
	title,
	subtitle,
	fullText,
	onTitleClick,
	titleActionLabel,
}: Props) {
	const loading = title === null;
	const lines = (
		<HeaderTitleLines
			title={
				typeof title === "string" ? (
					<span className={headerTitleTextClass}>{title}</span>
				) : (
					title
				)
			}
			subtitle={subtitle}
			hint={
				onTitleClick && (
					<ChevronRight
						className="size-3.5 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
				)
			}
		/>
	);

	return (
		<>
			<PageBackButton back={back} />
			{/* The heading wraps the button rather than sitting in it, since a
			    button holds phrasing content only. */}
			<h1 className="flex min-w-0 flex-1" aria-busy={loading || undefined}>
				{loading && <span className="sr-only">Loading</span>}
				{onTitleClick ? (
					<button
						type="button"
						onClick={onTitleClick}
						aria-label={titleActionLabel}
						title={fullText}
						className={`${headerTitleBoxClass} ${headerTitlePressableClass}`}
					>
						{lines}
					</button>
				) : (
					// A span: an `h1` holds phrasing content only.
					<span title={fullText} className={headerTitleBoxClass}>
						{lines}
					</span>
				)}
			</h1>
		</>
	);
}

function PageBackButton({ back }: { back: PageBack | null }) {
	if (back === null) {
		return (
			<span
				aria-hidden="true"
				className="flex size-11 shrink-0 items-center justify-center"
			>
				<span className={`size-5 ${headerSkeletonClass}`} />
			</span>
		);
	}
	if (back.to === "chat")
		return <BackToChatHeaderButton onClick={back.onClick} />;
	return (
		<button
			type="button"
			onClick={back.onClick}
			className={headerIconButtonClass}
			aria-label={back.label}
		>
			<ArrowLeft className="size-5" aria-hidden="true" />
		</button>
	);
}

function BackToChatHeaderButton({ onClick }: { onClick: () => void }) {
	const hasUnread = useOpenSessionUnread();
	return (
		<button
			type="button"
			onClick={onClick}
			className={`relative ${headerIconButtonClass}`}
			aria-label="Back to chat"
		>
			<MessageSquare className="size-5" aria-hidden="true" />
			{/* On the icon's corner, not the box's, and ringed in the header's
			    colour so it does not run into the icon's stroke. */}
			<BadgeDot
				show={hasUnread}
				className="top-2.5 right-2.5 ring-2 ring-th-bg-primary"
			/>
		</button>
	);
}
