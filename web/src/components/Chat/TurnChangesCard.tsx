import { FileDiff } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { proposedChangeText } from "../../lib/proposedChange";
import {
	type FileEdit,
	type LineCounts,
	type TurnFile,
	type TurnFileMarker,
	turnChanges,
} from "../../lib/turnChanges";
import { useWSStore } from "../../lib/wsStore";
import type { ContentPart } from "../../types/message";
import { CollapsibleBody } from "../ui";
import {
	changeRowCount,
	LineCountsLabel,
	ProposedChange,
	proposedChangeHeader,
} from "./ProposedChange";
import { anchorCandidateProps } from "./scrollAnchor";
import { PathLine } from "./ToolInvocation";
import { Chip, Detail, RowButton } from "./ToolRow";
import { Section } from "./ToolSection";

/**
 * Up to this many files are all listed. Past it the card lists FOLDED_ROWS and
 * a row for the rest — two below the limit, so "Show 1 more" never appears.
 */
const FILE_LIMIT = 7;
const FOLDED_ROWS = 5;

const MARKER_SPOKEN: Record<TurnFileMarker, string> = {
	new: "new file",
	deleted: "deleted",
	renamed: "renamed",
	rewritten: "rewritten",
};

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The counts read aloud. Lines whose replaced content is unknown were written,
 * not added: there is no removal to set them against.
 */
function spokenLines(lines: LineCounts | null): string | undefined {
	if (!lines) return undefined;
	const { added, removed } = lines;
	if (removed === undefined) {
		return added > 0 ? `${plural(added, "line")} written` : undefined;
	}
	if (added > 0 && removed > 0) {
		return `${plural(added, "line")} added, ${removed} removed`;
	}
	if (added > 0) return `${plural(added, "line")} added`;
	if (removed > 0) return `${plural(removed, "line")} removed`;
	return undefined;
}

/**
 * The directory as `Detail` takes a path: its last directory is the tail, the
 * part that tells two `index.ts` apart, and the rest fades out from the left.
 */
function dirParts(dir: string): { head: string; tail: string } {
	const cut = dir.search(/[^/\\]*$/);
	if (cut === dir.length) return { head: "", tail: dir };
	return { head: dir.slice(0, cut), tail: dir.slice(cut) };
}

/**
 * One change as the tool body shows it — the same `Section`, header counts,
 * wrap switch and copy, clamped in place with *Full screen* — so a reviewer
 * reads it the same in the card as on its tool row.
 */
function EditSection({
	edit,
	step,
	fileName,
}: {
	edit: FileEdit;
	/** Its place among the file's changes, when there is more than one. */
	step?: number;
	fileName: string;
}) {
	const { change, run } = edit;
	// Counting reads the whole diff; `change` is the same object every render.
	const header = useMemo(() => proposedChangeHeader(change), [change]);
	const count = useMemo(
		() => ({ noun: "line" as const, total: changeRowCount(change) }),
		[change],
	);
	const noun = change.kind === "write" ? "Content" : "Change";
	return (
		<Section
			label={step ? `${step} · ${run.name}` : noun}
			// Named by what it copies, and by which step when several could.
			copyLabel={`Copy ${noun.toLowerCase()}${step ? ` of ${step} · ${run.name}` : ""}`}
			{...header}
			copyText={proposedChangeText(change)}
			fullScreenTitle={`${run.name} · ${fileName}`}
			budget="main"
			count={count}
		>
			{/* Not "not in the transcript": an earlier step of this turn may have
			    written the very content this one replaced. */}
			{edit.rewritten && (
				<p className="pb-1 text-th-text-muted">
					Whole file written — what it replaced is not in this call.
				</p>
			)}
			<ProposedChange change={change} />
		</Section>
	);
}

function FileBody({
	file,
	onOpenFile,
}: {
	file: TurnFile;
	onOpenFile?: (path: string) => void;
}) {
	const numbered = file.edits.length > 1;
	return (
		<>
			<PathLine
				path={file.path}
				// A deleted file is not there to open.
				onOpenFile={file.marker === "deleted" ? undefined : onOpenFile}
			/>
			{/* One diff per edit, in order. Edits carry fragments, not the file, so
			    there is nothing to compose a net diff from that could be trusted. */}
			{file.edits.map((edit, index) => (
				<EditSection
					// The run alone does not tell edits apart: a Codex payload may list
					// one path twice.
					key={`${edit.run.id}:${index}`}
					edit={edit}
					step={numbered ? index + 1 : undefined}
					fileName={file.name}
				/>
			))}
		</>
	);
}

function FileRow({
	file,
	onOpenFile,
}: {
	file: TurnFile;
	onOpenFile?: (path: string) => void;
}) {
	// Nothing but the user opens a row (docs/tool-call-ui.md).
	const [expanded, setExpanded] = useState(false);
	const bodyId = useId();
	const { head, tail } = dirParts(file.dir);
	const spoken = [
		file.dir ? `${file.name} in ${file.dir}` : file.name,
		file.marker && MARKER_SPOKEN[file.marker],
		spokenLines(file.lines),
	]
		.filter(Boolean)
		.join(", ");

	return (
		<div className="border-t border-th-border">
			<RowButton
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={null}
				controls={bodyId}
			>
				<span className="sr-only">{spoken}</span>
				{/* The visible line abbreviates what the sentence above says, so it is
				    not read a second time. */}
				<span aria-hidden className="flex items-baseline gap-1.5">
					{/* Shrinks only once the directory is gone: the chip and the counts
					    must never be the part that is pushed out. */}
					<span className="min-w-0 max-w-[60%] truncate text-th-text-primary">
						{file.name}
					</span>
					<Detail detail={head} detailTail={tail} />
					{/* `Detail` takes the slack; without a directory something else
					    has to, or the counts would sit against the name. */}
					{!file.dir && <span className="flex-1" />}
					{file.marker && <Chip>{file.marker}</Chip>}
					<LineCountsLabel lines={file.lines} />
				</span>
			</RowButton>
			<div id={bodyId}>
				<CollapsibleBody expanded={expanded}>
					{/* A file row does not stick, so an opened diff's header pins at the
					    transcript's top rather than under a bar (`section-bar`). */}
					<div className="space-y-3 border-t border-th-border bg-th-bg-secondary p-2 [--section-bar-top:0px]">
						<FileBody file={file} onOpenFile={onOpenFile} />
					</div>
				</CollapsibleBody>
			</div>
		</div>
	);
}

interface Props {
	/** One settled assistant message's parts: the turn. */
	parts: ContentPart[];
	onOpenFile?: (path: string) => void;
}

/**
 * The files a turn changed, at its end: one row per file, each opening in
 * place onto that file's diffs. Drawn in the tool list's grammar and told apart
 * from one only by its header, the one row that is not a button.
 *
 * Callers render it once the turn has settled; while it runs, the group
 * summaries already count the edits, and a box growing at the tail would push
 * at the content streaming in above it. A subagent the turn left running in
 * the background can still add rows afterwards: its edits are this turn's too,
 * and they land at the tail, under nothing but the actions.
 */
export function TurnChangesCard({ parts, onOpenFile }: Props) {
	const workDir = useWSStore((state) => state.workDir);
	const changes = useMemo(() => turnChanges(parts, workDir), [parts, workDir]);
	const [showAll, setShowAll] = useState(false);
	const titleId = useId();
	const rowsRef = useRef<HTMLDivElement>(null);

	// The button that revealed the rest is gone; focus goes to the first row it
	// revealed rather than falling back to the page.
	useEffect(() => {
		if (!showAll) return;
		rowsRef.current
			?.querySelectorAll<HTMLButtonElement>(":scope > div > button")
			[FOLDED_ROWS]?.focus();
	}, [showAll]);

	const { files, lines } = changes;
	if (files.length === 0) return null;
	const folded = !showAll && files.length > FILE_LIMIT;
	const shown = folded ? files.slice(0, FOLDED_ROWS) : files;
	const spokenTotal = spokenLines(lines);

	return (
		// A part wrapper's sibling, and an anchor candidate like one: with rows
		// open it can be screens tall.
		<div className="mt-2" {...anchorCandidateProps}>
			{/* A group, not a region: one landmark per turn would drown out the
			    page's own. */}
			{/* biome-ignore lint/a11y/useSemanticElements: a list of files, not form controls a fieldset would group */}
			<div
				role="group"
				aria-labelledby={titleId}
				// `overflow-clip`, not `overflow-hidden`, as `ToolList`'s: `hidden`
				// would make the card the scroll container an opened diff's header
				// pins to, and the card never scrolls.
				className="overflow-clip rounded-lg border border-th-border text-xs"
			>
				<div ref={rowsRef} className="-mt-px">
					<div className="flex min-h-9 flex-col justify-center border-t border-th-border px-2 py-1.5 sm:px-2.5">
						<div className="flex items-start gap-1.5">
							{/* In the chevron's column, so the title lines up with the
							    file names under it. */}
							<FileDiff className="mt-0.5 size-3 shrink-0 text-th-text-muted" />
							<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
								<span
									id={titleId}
									className="min-w-0 flex-1 truncate text-th-text-secondary"
								>
									{plural(files.length, "file")} changed
								</span>
								<span aria-hidden className="contents">
									<LineCountsLabel lines={lines} />
								</span>
								{spokenTotal && <span className="sr-only">{spokenTotal}</span>}
							</span>
						</div>
					</div>
					{shown.map((file) => (
						<FileRow key={file.path} file={file} onOpenFile={onOpenFile} />
					))}
					{folded && (
						<div className="border-t border-th-border">
							<RowButton
								expanded={false}
								onToggle={() => setShowAll(true)}
								glyph={null}
								// It goes away once pressed, so there is no state to report.
								toggleable={false}
							>
								<span className="block truncate text-th-text-muted">
									Show {plural(files.length - FOLDED_ROWS, "more file")}
								</span>
							</RowButton>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
