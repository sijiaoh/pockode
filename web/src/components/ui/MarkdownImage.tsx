import { useIsInSheet } from "@pockode/shared";
import type { Element } from "hast";
import { Image, ImageOff } from "lucide-react";
import {
	type ComponentPropsWithoutRef,
	createContext,
	type ReactNode,
	type Ref,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { useContents } from "../../hooks/useContents";
import { useImageSrc } from "../../hooks/useImageSrc";
import { useInView } from "../../hooks/useInView";
import { useWSStore } from "../../lib/wsStore";
import { isFileContent } from "../../types/contents";
import { omittedLabel } from "../../utils/attachment";
import { errorMessage } from "../../utils/errorMessage";
import { getFileViewState } from "../../utils/fileView";
import {
	BLOCK_IMAGE_PROPERTY,
	LINKED_IMAGE_PROPERTY,
	resolveMarkdownImage,
} from "../../utils/markdownImage";
import { type ImageMediaItem, MediaViewer } from "../Media";
import AttachmentChip from "./AttachmentChip";
import Skeleton from "./Skeleton";

/** What the host rendering the Markdown says about where it lives. */
export interface MarkdownImageSettings {
	/**
	 * The work-directory-relative directory a relative image path is read from;
	 * empty is the root, null a text outside the work directory.
	 */
	baseDir: string | null;
	/** Absent when the host cannot navigate to a file. */
	onOpenFile?: (path: string) => void;
	/** The external hosts the reader has allowed in this text. */
	allowedHosts: ReadonlySet<string>;
	allowHost: (host: string) => void;
}

export const MarkdownImageContext = createContext<MarkdownImageSettings>({
	baseDir: "",
	allowedHosts: new Set(),
	allowHost: () => {},
});

/**
 * External URLs already requested, which need no second tap wherever they
 * mount again: that host has received exactly that request. In memory only, so
 * a reload asks again.
 */
const requestedExternalUrls = new Set<string>();

/** Marks a held external image drawn inside a link, which has no button. */
const HELD_HOST_ATTRIBUTE = "data-held-image-host";

/**
 * The hosts of the held external images inside `root` — a link, which takes
 * the first activation as their Load.
 */
export function heldImageHosts(root: ParentNode): string[] {
	return Array.from(
		root.querySelectorAll(`[${HELD_HOST_ATTRIBUTE}]`),
		(held) => held.getAttribute(HELD_HOST_ATTRIBUTE) ?? "",
	);
}

type Shape = "block" | "inline";

/** What every state of one image shares. */
interface Common {
	shape: Shape;
	/** Alt text, else the file name: the open button's name, the viewer's title. */
	label: string;
	title?: string;
	/** The `src` as written, so a wrong path can be read in full. */
	tooltip: string;
	/** Absent when a tap must not open the viewer. */
	onOpen?: (item: ImageMediaItem) => void;
}

/** Long enough for any path; a `data:` URL is dropped and need not be read whole. */
const TOOLTIP_LIMIT = 300;

function ImageFailure({
	shape,
	label,
	tooltip,
	detail,
	error = false,
	onRetry,
	takeFocus = false,
}: Pick<Common, "shape" | "label" | "tooltip"> & {
	detail: string;
	/** Something went wrong, as opposed to the image never being one to show. */
	error?: boolean;
	onRetry?: () => void;
	/** Set when the image it replaces held the focus, which unmounted with it. */
	takeFocus?: boolean;
}) {
	// Stable, so a text streaming around it does not pull the focus back.
	const focusRef = useCallback(
		(node: HTMLSpanElement | null) => {
			if (node && takeFocus) node.focus();
		},
		[takeFocus],
	);
	const focusable = takeFocus ? -1 : undefined;
	if (shape === "block") {
		return (
			<span
				ref={focusRef}
				tabIndex={focusable}
				className="markdown-image block focus-visible:outline-none"
			>
				<AttachmentChip
					icon={ImageOff}
					iconClassName={error ? "text-th-error" : undefined}
					title={label}
					detail={detail}
					tooltip={tooltip}
					action={onRetry && { label: "Retry", onClick: onRetry }}
				/>
			</span>
		);
	}
	// No Retry in a sentence: an inline action there is a mis-tap waiting to
	// happen. The label keeps a failed badge saying what it was.
	return (
		<span
			ref={focusRef}
			tabIndex={focusable}
			className="markdown-image text-th-text-muted focus-visible:outline-none"
			title={`${tooltip}\n${detail}`}
		>
			<ImageOff
				className="mr-0.5 inline size-[1em] align-[-0.125em]"
				aria-hidden="true"
			/>
			{label}
		</span>
	);
}

type Status = "loading" | "loaded" | "error";

/**
 * The image itself, once something can say where its bytes are: a skeleton
 * until it decodes, then the image at its shape's size — a button that opens
 * the viewer when `onOpen` is given.
 */
function ImageFrame({
	frameRef,
	focusable = false,
	src,
	external = false,
	item,
	failureDetail,
	shape,
	label,
	title,
	tooltip,
	onOpen,
}: Common & {
	frameRef?: Ref<HTMLSpanElement>;
	/** Whether the frame can hold the focus handed to it from a Load. */
	focusable?: boolean;
	src: string | null;
	external?: boolean;
	/** What the viewer shows; null until the description says. */
	item: ImageMediaItem | null;
	/** What a failed `<img>` means for this source. */
	failureDetail: string;
}) {
	const [status, setStatus] = useState<Status>("loading");
	// Bumped to remount the <img>: re-assigning the same src after a failure
	// does not make the browser try again.
	const [attempt, setAttempt] = useState(0);
	const [failureTakesFocus, setFailureTakesFocus] = useState(false);

	// New bytes — the file rewritten on disk — are judged afresh. Adjusted during
	// render for the reason `ImagePreview` gives.
	const [renderedSrc, setRenderedSrc] = useState(src);
	if (renderedSrc !== src) {
		setRenderedSrc(src);
		setStatus("loading");
	}

	if (status === "error") {
		return (
			<ImageFailure
				shape={shape}
				label={label}
				tooltip={tooltip}
				detail={failureDetail}
				error
				onRetry={() => {
					setStatus("loading");
					setAttempt((n) => n + 1);
				}}
				takeFocus={failureTakesFocus}
			/>
		);
	}

	const loaded = status === "loaded";
	const block = shape === "block";
	const img = src && (
		<img
			key={attempt}
			src={src}
			alt={label}
			title={title}
			loading={external ? "lazy" : undefined}
			referrerPolicy={external ? "no-referrer" : undefined}
			onLoad={() => setStatus("loaded")}
			onError={(event) => {
				// The frame holding the focus is the one around this <img>.
				setFailureTakesFocus(
					focusable &&
						(document.activeElement?.contains(event.currentTarget) ?? false),
				);
				setStatus("error");
			}}
			// Natural size, shrunk to the column and the shape's height cap and
			// never enlarged: a small icon on its own line stays small.
			className={
				block
					? "block h-auto max-h-80 w-auto max-w-full sm:max-h-96"
					: "inline h-auto max-h-[2em] w-auto max-w-full align-middle"
			}
		/>
	);

	// The frame is the same element loading and loaded, so the <img> in it is
	// not remounted — and read again — when it decodes. While loading it is
	// placed out of the way and hidden rather than unmounted: when a browser
	// decodes a `display: none` image is up to it, and a lazy one is never read.
	const place = loaded
		? block
			? "block"
			: "inline-block max-w-full align-middle"
		: "invisible absolute top-0 left-0 max-w-full";
	const box = block
		? "block w-fit max-w-full rounded-lg"
		: "inline-block max-w-full rounded align-middle";
	// A box of its own inside the button: the frame clips the image to its
	// corners, and clipping on the button would clip its `touch-target` too.
	const look = (
		<span
			className={
				block
					? // The attachment thumbnail's frame: a transparent PNG stays
						// legible in both themes, a white screenshot does not bleed
						// into the page.
						"block overflow-hidden rounded-lg border border-th-border bg-th-bg-secondary"
					: // Bare: a border round each badge in a row would read as buttons.
						"inline-block max-w-full align-middle"
			}
		>
			{img}
		</span>
	);
	const frame = (
		<span className={place}>
			{onOpen ? (
				// `touch-target` for an inline image at 2em, under the hit-area
				// floor, and for a small icon alone on its line.
				<button
					type="button"
					disabled={!loaded}
					onClick={item ? () => onOpen(item) : undefined}
					aria-haspopup="dialog"
					aria-label={`View ${label}`}
					className={`touch-target ${box} pointer-fine:cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent`}
				>
					{look}
				</button>
			) : (
				<span className={box}>{look}</span>
			)}
		</span>
	);

	const focus = focusable
		? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
		: "";
	return block ? (
		<span
			ref={frameRef}
			tabIndex={focusable ? -1 : undefined}
			className={`markdown-image relative block rounded-lg ${focus}`}
		>
			{!loaded && (
				// Full width at the reserved height: what a wide screenshot fits to
				// on a phone, so the common case barely moves when it lands.
				<Skeleton
					className="h-[var(--async-media-height)] w-full rounded-lg"
					label={label}
				/>
			)}
			{frame}
		</span>
	) : (
		<span
			ref={frameRef}
			tabIndex={focusable ? -1 : undefined}
			className={`markdown-image relative inline-block max-w-full rounded align-middle ${focus}`}
		>
			{!loaded && (
				// So a badge row does not arrive as one collapsed line and then
				// spread out.
				<span className="inline-block h-[1em] w-[3em] align-middle">
					<Skeleton className="size-full rounded" label={label} />
				</span>
			)}
			{frame}
		</span>
	);
}

/**
 * A work-directory file, read through the image pipeline once on screen —
 * the description, then the bytes — as an attachment thumbnail is.
 */
function WorkspaceImage({
	path,
	name,
	...common
}: Common & { path: string; name: string }) {
	const { ref, inView } = useInView<HTMLSpanElement>();
	const contents = useContents(path, inView);
	// A path can name a directory, whose listing is cached under the same key.
	const file =
		contents.data && isFileContent(contents.data) ? contents.data : null;
	const view = file ? getFileViewState(file, { kind: "file", path }) : null;
	const image = useImageSrc(
		view?.kind === "image" ? view.source : null,
		inView,
	);

	if (contents.error && !contents.isFetching) {
		return (
			<ImageFailure
				{...common}
				detail={errorMessage(contents.error) || "Couldn't load image"}
				error
				onRetry={() => void contents.refetch()}
			/>
		);
	}
	if (image.error) {
		return (
			<ImageFailure
				{...common}
				detail={errorMessage(image.error) || "Couldn't load image"}
				error
				onRetry={image.retry}
			/>
		);
	}
	// Too large to send, binary, or not an image at all: the strip's words.
	if (contents.data && view?.kind !== "image") {
		return (
			<ImageFailure
				{...common}
				detail={(file && omittedLabel(file)) ?? "Can't be previewed"}
			/>
		);
	}

	return (
		<ImageFrame
			{...common}
			frameRef={ref}
			src={image.src}
			failureDetail="Image can't be displayed"
			item={
				view?.kind === "image"
					? {
							kind: "image",
							name: common.label,
							saveAs: name,
							mime: view.mime,
							size: view.size,
							source: view.source,
						}
					: null
			}
		/>
	);
}

/**
 * A picture on someone else's server, which only the `<img>` reads. Not read
 * until on screen, like a workspace image — the browser's own `loading="lazy"`
 * reaches as far ahead as it likes — so a transcript paged back does not call
 * every host it ever named.
 */
function ExternalImage({
	url,
	name,
	takeFocus,
	...common
}: Common & {
	url: string;
	name: string;
	/** Set on the image whose Load was pressed, which unmounted with it. */
	takeFocus: boolean;
}) {
	const { ref: watch, inView } = useInView<HTMLSpanElement>();
	// Where the Load was, so a keyboard or screen reader is not dropped to the
	// top of the page; the frame's own View button is disabled while it loads.
	const ref = useCallback(
		(node: HTMLSpanElement | null) => {
			watch(node);
			if (node && takeFocus) node.focus();
		},
		[watch, takeFocus],
	);
	useEffect(() => {
		if (inView) requestedExternalUrls.add(url);
	}, [inView, url]);
	return (
		<ImageFrame
			{...common}
			frameRef={ref}
			focusable={takeFocus}
			src={inView ? url : null}
			external
			failureDetail={`Couldn't load image · ${new URL(url).host}`}
			item={{
				kind: "image",
				name: common.label,
				saveAs: name,
				mime: "",
				size: 0,
				source: { kind: "external", url },
			}}
		/>
	);
}

/**
 * An external image the reader has not asked for: a placeholder naming the
 * host, and nothing sent to it until Load. Inside a link it has no button —
 * one may not nest in an `<a>` — and the link takes the first activation.
 */
function HeldExternalImage({
	host,
	linked,
	onLoad,
	shape,
	label,
	tooltip,
}: Pick<Common, "shape" | "label" | "tooltip"> & {
	host: string;
	linked: boolean;
	onLoad: () => void;
}) {
	const loadLabel = `Load ${label} from ${host}`;
	const hint = linked && (
		<span className="sr-only">
			Image not loaded; activating the link loads it first.
		</span>
	);
	const held = linked ? { [HELD_HOST_ATTRIBUTE]: host } : {};

	if (shape === "block") {
		return (
			<span {...held} className="markdown-image block">
				<AttachmentChip
					icon={Image}
					title={label}
					detail={`Not loaded · ${host}`}
					wrapDetail
					tooltip={tooltip}
					action={
						linked
							? undefined
							: { label: "Load", ariaLabel: loadLabel, onClick: onLoad }
					}
				/>
				{hint}
			</span>
		);
	}

	const look =
		"markdown-image inline-flex max-w-full items-center gap-1 rounded border border-th-border px-1 align-middle text-[0.875em] leading-tight";
	const content = (
		<>
			<Image
				className="size-[1em] shrink-0 text-th-text-muted"
				aria-hidden="true"
			/>
			<span className="max-w-[12em] truncate text-th-text-primary">
				{label}
			</span>
			{/* Wrapped, never cut: a host's owner is its last part. */}
			<span className="min-w-0 text-th-text-muted [overflow-wrap:anywhere]">
				· {host}
			</span>
		</>
	);
	if (linked) {
		return (
			<span {...held} className={look} title={tooltip}>
				{content}
				{hint}
			</span>
		);
	}
	// `touch-target`: a line's height cannot grow to the hit-area floor.
	return (
		<button
			type="button"
			onClick={onLoad}
			aria-label={loadLabel}
			title={tooltip}
			className={`touch-target ${look} hover:bg-th-overlay-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent`}
		>
			{content}
		</button>
	);
}

type ImageProps = ComponentPropsWithoutRef<"img"> & {
	node?: Element;
};

/**
 * An image written in Markdown (docs/markdown-images-ui.md): a work-directory
 * file through the image pipeline, an external one through a plain `<img>`
 * once the reader allows its host, anything else a placeholder saying why —
 * never the browser's broken-image icon.
 */
export function MarkdownImage({ node, src, alt, title }: ImageProps) {
	const { baseDir, onOpenFile, allowedHosts, allowHost } =
		useContext(MarkdownImageContext);
	const workDir = useWSStore((state) => state.workDir);
	const inSheet = useIsInSheet();
	// Held here, outside every loading and failure branch below, so an image
	// that changes state underneath does not take the viewer with it.
	const [viewing, setViewing] = useState<ImageMediaItem | null>(null);
	// The URL, not a flag: an image swapped in here later did not have its Load
	// pressed, and must not take the focus when it mounts.
	const [pressedLoad, setPressedLoad] = useState<string | null>(null);

	const raw = typeof src === "string" ? src : "";
	const target = resolveMarkdownImage(raw, baseDir, workDir);
	const label = alt || target.name || "Image";
	const properties = node?.properties ?? {};
	const linked = Boolean(properties[LINKED_IMAGE_PROPERTY]);
	const common: Common = {
		shape: properties[BLOCK_IMAGE_PROPERTY] ? "block" : "inline",
		label,
		title,
		tooltip:
			raw.length > TOOLTIP_LIMIT ? `${raw.slice(0, TOOLTIP_LIMIT)}…` : raw,
		// A linked image is the link's content, which a tap follows. Inside a
		// sheet the viewer — itself a sheet — cannot open.
		onOpen: linked || inSheet ? undefined : setViewing,
	};

	let body: ReactNode;
	switch (target.kind) {
		case "workspace":
			body = (
				<WorkspaceImage
					key={target.path}
					{...common}
					path={target.path}
					name={target.name}
				/>
			);
			break;
		case "external": {
			const host = new URL(target.url).host;
			body =
				allowedHosts.has(host) || requestedExternalUrls.has(target.url) ? (
					<ExternalImage
						key={target.url}
						{...common}
						url={target.url}
						name={target.name}
						takeFocus={pressedLoad === target.url}
					/>
				) : (
					<HeldExternalImage
						key={target.url}
						{...common}
						host={host}
						linked={linked}
						onLoad={() => {
							setPressedLoad(target.url);
							allowHost(host);
						}}
					/>
				);
			break;
		}
		case "outside":
			body = <ImageFailure {...common} detail="Outside the work directory" />;
			break;
		case "unsupported":
			body = (
				<ImageFailure {...common} detail="Not shown: unsupported address" />
			);
			break;
	}

	const path = target.kind === "workspace" ? target.path : null;
	return (
		<>
			{body}
			{viewing && (
				<MediaViewer
					item={viewing}
					openInFiles={
						path !== null && onOpenFile ? () => onOpenFile(path) : undefined
					}
					onClose={() => setViewing(null)}
				/>
			)}
		</>
	);
}
