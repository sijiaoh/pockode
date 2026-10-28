import { Ellipsis, TriangleAlert } from "lucide-react";
import { memo, useId } from "react";
import {
	type ChangedFile,
	type ChangeKind,
	changeKindOf,
	checkStateOf,
	lineStatOf,
} from "../../lib/gitChanges";
import { splitExtension, splitPath } from "../../utils/path";
import { iconButtonClass } from "../ui/iconButtonClass";
import LineCounts from "./LineCounts";
import StageCheckbox, { StageGutter } from "./StageCheckbox";

/** Px per tree level, for the row's content; the checkbox column stays put. */
export const TREE_INDENT = 16;

interface BaseProps {
	file: ChangedFile;
	isActive: boolean;
	onSelect: (file: ChangedFile) => void;
}

interface WritableProps extends BaseProps {
	readOnly?: false;
	/** Tree depth below the root; 0 in the flat list. */
	depth: number;
	busy: boolean;
	onToggle: (file: ChangedFile) => void;
	onMore: (file: ChangedFile) => void;
}

/**
 * The drawer's list below `expanded`, where nothing writes: no checkbox, no
 * `⋯`, and the staging state left unsaid rather than drawn as a box that does
 * nothing (docs/sidebar-ui.md).
 */
interface ReadOnlyProps extends BaseProps {
	readOnly: true;
}

type Props = WritableProps | ReadOnlyProps;

const KIND_WORD: Partial<Record<ChangeKind, string>> = {
	added: "Added",
	untracked: "Untracked",
	deleted: "Deleted",
};

/** The details' status words, after the directory; none for a plain modification. */
function statusWords(file: ChangedFile, kind: ChangeKind): string[] {
	const words: string[] = [];
	if (file.conflict) {
		words.push("Conflict");
	} else if (kind === "renamed") {
		const from = file.staged?.orig_path;
		if (from) {
			const old = splitPath(from);
			const now = splitPath(file.path);
			// The old name alone when only the name changed.
			words.push(
				`Renamed from ${old.directory === now.directory ? old.fileName : from}`,
			);
		} else {
			words.push("Renamed");
		}
	} else if (KIND_WORD[kind]) {
		words.push(KIND_WORD[kind]);
	}
	if (file.submodule) words.push("Submodule");
	return words;
}

/**
 * One changed file: its checkbox, the row that opens it, and `⋯` for the
 * rest. The three are siblings, never nested. Read-only, the row is the
 * button alone.
 */
const ChangedFileRow = memo(function ChangedFileRow(props: Props) {
	const { file, isActive, onSelect } = props;
	const kind = changeKindOf(file);
	const { fileName, directory } = splitPath(file.path);
	const { stem, extension: ext } = splitExtension(fileName);
	const { lines, binary } = lineStatOf(file);
	const dir = directory.replace(/\/$/, "");
	const status = statusWords(file, kind).join(" · ");
	const detailsId = useId();
	const countsId = useId();

	return (
		<div
			className={`group relative flex min-h-[44px] items-center rounded-lg transition-colors ${
				isActive
					? "bg-th-bg-tertiary before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-th-accent"
					: "hover:bg-th-bg-tertiary"
			}`}
		>
			{/* Staging a conflict is how git is told it is resolved, so no single
			    press may do it: the conflict view's `Mark resolved` or the agent
			    does (docs/git-conflict-ui.md). */}
			{props.readOnly ? null : file.conflict ? (
				<StageGutter conflict />
			) : (
				<StageCheckbox
					state={checkStateOf(file)}
					label={`Stage ${file.path}`}
					busy={props.busy}
					onToggle={() => props.onToggle(file)}
				/>
			)}
			<button
				type="button"
				onClick={() => onSelect(file)}
				aria-label={
					file.conflict
						? `Review ${file.path}, conflicted`
						: `Review ${file.path}`
				}
				// The name replaces the button's text, so what the details and the
				// counts say — Deleted or Untracked before a discard — is
				// handed back as its description. An id with no element is
				// skipped.
				aria-describedby={`${detailsId} ${countsId}`}
				aria-current={isActive ? "true" : undefined}
				style={
					props.readOnly
						? undefined
						: { paddingLeft: props.depth * TREE_INDENT }
				}
				className={`flex min-w-0 flex-1 items-center gap-2 self-stretch py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${
					props.readOnly ? "rounded-lg px-3" : "pr-1"
				}`}
			>
				{/* The drawer's entries' icon column (GitTab's `Entry`: `px-3`, a
				    `size-4` icon, `gap-2.5`), so the name lines up with
				    "Changes" and reads as under it. */}
				{props.readOnly && (
					<span className="mr-0.5 flex w-4 shrink-0 justify-center">
						{file.conflict && (
							<TriangleAlert
								className="size-4 text-th-warning"
								aria-hidden="true"
							/>
						)}
					</span>
				)}
				<span className="min-w-0 flex-1 @git-row:flex @git-row:items-baseline @git-row:gap-3">
					<span
						title={fileName}
						className={`flex min-w-0 text-sm text-th-text-primary @git-row:max-w-[60%] @git-row:shrink-0 ${
							kind === "deleted" ? "*:line-through" : ""
						}`}
					>
						<span className="truncate">{stem}</span>
						<span className="shrink-0">{ext}</span>
					</span>
					{(dir || status) && (
						<span
							id={detailsId}
							className="flex min-w-0 text-xs text-th-text-muted @git-row:flex-1"
						>
							{/* From the head: the deepest folder is what tells files
							    apart. `bdi` keeps rtl from reordering the path. */}
							{dir && (
								// Gives way before the status words, which say more.
								<span
									title={dir}
									className="min-w-0 shrink-[100] truncate [direction:rtl]"
								>
									<bdi>{dir}</bdi>
								</span>
							)}
							{status && (
								<span title={status} className="min-w-0 shrink truncate">
									{dir && " · "}
									{status}
								</span>
							)}
						</span>
					)}
				</span>
				<LineCounts
					id={countsId}
					lines={lines}
					binary={binary}
					className="shrink-0"
				/>
			</button>
			{!props.readOnly && (
				<button
					type="button"
					onClick={() => props.onMore(file)}
					aria-label={`More actions for ${file.path}`}
					className={`${iconButtonClass()} mr-1`}
				>
					<Ellipsis className="h-4 w-4" aria-hidden="true" />
				</button>
			)}
		</div>
	);
});

export default ChangedFileRow;
