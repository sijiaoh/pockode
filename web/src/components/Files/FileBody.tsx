import { Binary, File, FileQuestion, FileWarning } from "lucide-react";
import { useLineLanding } from "../../hooks/useLineLanding";
import { useWrapKeepingPlace } from "../../hooks/useWrapKeepingPlace";
import { formatBytes } from "../../utils/bytes";
import {
	type FileViewState,
	getMimeType,
	isImageMime,
} from "../../utils/fileView";
import { splitPath } from "../../utils/path";
import { FileContentDisplay, FileStateCard, rendersMarkdown } from "../ui";
import ImagePreview from "./ImagePreview";
import MediaPreview from "./MediaPreview";
import PagePreview from "./PagePreview";

interface Props {
	state: FileViewState;
	path: string;
	/**
	 * Offered on the cards that stand in for content, since a file that cannot be
	 * previewed is exactly the one the user needs to open elsewhere — the icon in
	 * the bottom bar is easy to miss when the page says "can't be previewed".
	 *
	 * Omitted on a diff, which has no single file to offer.
	 */
	downloadAction?: { label: string; onClick: () => void; disabled?: boolean };
	/**
	 * Drop the rendering to source. For text: no syntax highlighting, and
	 * Markdown as its source — large files force it on, and a viewer may also
	 * offer it, which is the only way to reach the highlighter's copy button on
	 * a Markdown file. For a page: its source, highlighted, instead of the page.
	 */
	plain?: boolean;
	/**
	 * Show the source of a file that would otherwise render — Markdown, or a
	 * page — highlighted, and numbered where `lineNumbers` asks. Unlike `plain`
	 * it keeps the colours: it is a way of reading the file, not a cost cut.
	 */
	source?: boolean;
	/**
	 * Set where the surrounding screen has no editing at all. The cards below
	 * otherwise explain why editing is disabled, which is written for the
	 * disabled Edit button in the viewer's bottom bar; with no such button on
	 * screen the sentence points at a control that isn't there, and implies a
	 * non-binary file here would be editable.
	 */
	readOnly?: boolean;
	/**
	 * What the image will turn out to be, where something knows before it
	 * decodes — an agent's content block reports it. See `ImagePreview`.
	 */
	imageDimensions?: { width: number; height: number };
	/**
	 * Number the lines of text, full-bleed. For a whole file being read; the
	 * source of a page or of Markdown gets them, the rendering does not.
	 */
	lineNumbers?: boolean;
	/**
	 * Wrap the numbered lines instead of scrolling them sideways — the reader's
	 * setting. Applied only where `offersWrap` says it can change something;
	 * elsewhere a numbered view stays unwrapped.
	 */
	wrap?: boolean;
	/**
	 * The line to open at: scrolled to and flashed on a fresh visit
	 * (`useLineLanding`). Only a numbered view has lines; elsewhere it is
	 * ignored.
	 */
	line?: number;
	/** Offered by a rendered `.md` file's images; takes a work-directory-relative path. */
	onOpenFile?: (path: string) => void;
}

/**
 * Said where a file's size, not the reader, turned its colours off. `wrap` is
 * the reader's wrap setting: on, the size has turned that off too, and saying
 * so keeps the setting's silence from reading as a bug.
 */
export function PlainTextNotice({ wrap = false }: { wrap?: boolean }) {
	return (
		<div className="shrink-0 border-b border-th-border bg-th-bg-secondary px-4 py-2 text-xs text-th-text-muted">
			{wrap
				? "Large file — showing plain text without line wrapping."
				: "Large file — showing plain text only."}
		</div>
	);
}

/**
 * Whether wrapping can change how `FileBody` draws `state`: numbered text
 * within the highlight limit, drawn as text — a page shown as its source
 * included. Past the limit wrapping would need an element per line the plain
 * path cannot afford; rendered Markdown and pages lay themselves out.
 */
export function offersWrap(
	state: FileViewState,
	path: string,
	{ plain, source }: Pick<Props, "plain" | "source"> = {},
): boolean {
	if (state.kind === "page")
		return (plain || source) === true && offersWrap(state.source, path);
	return (
		state.kind === "text" &&
		state.highlight &&
		!rendersMarkdown(path, plain || source)
	);
}

function fileDetails(mime: string, size: number) {
	return [
		{ label: "Type", value: getMimeType(mime) },
		{ label: "Size", value: formatBytes(size) },
	];
}

function FileBody({
	state,
	path,
	downloadAction,
	plain,
	source,
	readOnly,
	imageDimensions,
	lineNumbers,
	wrap,
	line,
	onOpenFile,
}: Props) {
	switch (state.kind) {
		case "empty":
			// A zero-byte file would otherwise render as blank space that reads as
			// a loading bug.
			return (
				<FileStateCard
					icon={File}
					title="Empty file"
					description="This file has no content."
				/>
			);

		case "text":
			return (
				<TextBody
					content={state.content}
					highlight={state.highlight}
					path={path}
					plain={plain}
					source={source}
					lineNumbers={lineNumbers}
					wrap={wrap}
					line={line}
					onOpenFile={onOpenFile}
				/>
			);

		case "page":
			return plain || source ? (
				<FileBody
					state={state.source}
					path={path}
					downloadAction={downloadAction}
					readOnly={readOnly}
					lineNumbers={lineNumbers}
					wrap={wrap}
					line={line}
				/>
			) : (
				<PagePreview
					origin={state.origin}
					fileName={splitPath(path).fileName}
					mime={state.mime}
					size={state.size}
					// What a rewrite changes. A commit never changes, so its page is
					// never reloaded by this.
					revision={
						state.source.kind === "text"
							? state.source.content
							: state.source.size
					}
				/>
			);

		case "image":
			return (
				<ImagePreview
					source={state.source}
					fileName={splitPath(path).fileName}
					mime={state.mime}
					size={state.size}
					dimensions={imageDimensions}
				/>
			);

		case "audio":
		case "video":
			return (
				<MediaPreview
					kind={state.kind}
					origin={state.origin}
					fileName={splitPath(path).fileName}
					mime={state.mime}
					size={state.size}
					downloadAction={downloadAction}
				/>
			);

		case "binary":
			return (
				<FileStateCard
					icon={Binary}
					title="Binary file"
					description="This file can't be previewed."
					details={fileDetails(state.mime, state.size)}
					footnote={
						readOnly ? undefined : "Editing is disabled for binary files."
					}
					action={downloadAction}
				/>
			);

		case "unavailable":
			// Not a refusal like the two above: the content was fine, it is just
			// gone — an attachment cleaned up with its session, a file deleted
			// since. Nothing about it is worth explaining as a limitation.
			return (
				<FileStateCard
					icon={FileQuestion}
					title="File not found"
					description="This file is no longer available."
				/>
			);

		case "too-large":
			return (
				<FileStateCard
					icon={FileWarning}
					iconClassName="text-th-warning"
					title={
						isImageMime(state.mime)
							? "Image is too large to preview"
							: "File is too large to preview"
					}
					description={
						state.limit === undefined
							? `This file is ${formatBytes(state.size)}.`
							: `This file is ${formatBytes(state.size)}. Files over ${formatBytes(
									state.limit,
								)} aren't loaded to keep the app responsive.`
					}
					details={fileDetails(state.mime, state.size)}
					footnote={
						readOnly ? undefined : "Editing is disabled for files this large."
					}
					action={downloadAction}
				/>
			);
	}
}

function TextBody({
	content,
	highlight,
	path,
	plain,
	source,
	lineNumbers,
	wrap,
	line,
	onOpenFile,
}: Pick<
	Props,
	"path" | "plain" | "source" | "lineNumbers" | "wrap" | "line" | "onOpenFile"
> & { content: string; highlight: boolean }) {
	const textPlain = !highlight || plain;
	const numbered = lineNumbers && !rendersMarkdown(path, textPlain || source);
	const wrappable =
		numbered === true &&
		offersWrap({ kind: "text", content, highlight }, path, { plain, source });
	const { containerRef, mark, clearMark } = useLineLanding(
		numbered ? line : undefined,
		content,
	);
	// A running flash was measured in the layout a toggle leaves.
	const wrapped = useWrapKeepingPlace(wrappable && wrap === true, {
		wrappable,
		content,
		containerRef,
		onRelayout: clearMark,
	});
	return (
		<>
			{/* Only the forced case is worth a banner: when the reader asked
			    for plain text themselves, saying so back is noise. */}
			{!highlight && <PlainTextNotice wrap={numbered && wrap} />}
			<div ref={containerRef} className={numbered ? undefined : "p-2"}>
				<FileContentDisplay
					content={content}
					filePath={path}
					plain={textPlain}
					source={source}
					lineNumbers={numbered}
					wrap={wrapped}
					mark={mark}
					onMarkEnd={clearMark}
					onOpenFile={onOpenFile}
				/>
			</div>
		</>
	);
}

export default FileBody;
