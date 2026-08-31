import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { contentsQueryKey } from "../../hooks/useContents";
import {
	FILE_SEARCH_QUERY_KEY,
	useFileSearch,
} from "../../hooks/useFileSearch";
import {
	type NameCollision,
	nameCollision,
	nextAvailableName,
} from "../../lib/fileUpload";
import {
	MAX_FILES_PER_UPLOAD,
	type NewUpload,
	onFileUploaded,
	type UploadItem,
	uploadActions,
	useWorktreeUploads,
} from "../../lib/uploadStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { ContentsResponse, Entry } from "../../types/contents";
import { parentDir } from "../../utils/path";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh } from "../ui";
import FileSearchBar from "./FileSearchBar";
import FileSearchResults from "./FileSearchResults";
import FileTree from "./FileTree";
import UploadButton from "./UploadButton";
import UploadConflictDialog from "./UploadConflictDialog";
import UploadQueue from "./UploadQueue";
import { FOLDER_DROP_REFUSED, useFileDrop } from "./useFileDrop";

interface Props {
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
}

/** A batch held back until the user says what to do about the names taken. */
interface PendingUpload {
	destPath: string;
	files: File[];
	/** Collisions with regular files; a folder's name is never replaceable. */
	conflicts: Map<File, NameCollision>;
}

/**
 * Said when a second batch arrives while the first is still being asked about.
 *
 * Names what happened to the files just picked: they are gone from the picker,
 * and a banner that only said "finish answering" would leave the user looking
 * for them in a queue they never reached.
 */
const BATCH_AWAITING_ANSWER =
	"Finish answering about the files already picked. Nothing was uploaded.";

/** `src/components/ui` -> `…/components/ui`, so the tail stays readable. */
function shortenPath(path: string): string {
	const parts = path.split("/");
	return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Says where the file under the cursor would land, for as long as it is held.
 *
 * Docked at the bottom rather than drawn as an overlay: an overlay would cover
 * the tree, which is exactly what the user is aiming at. Always transparent to
 * the pointer, or crossing it would change the answer it is displaying.
 */
function DropTargetBar({
	destPath,
	refusal,
}: {
	destPath: string;
	/** Why this drag will not be taken, when it will not be. */
	refusal: string | null;
}) {
	return (
		<div
			className={`pointer-events-none flex min-h-[36px] shrink-0 items-center gap-1.5 px-3 text-xs ${
				refusal
					? "bg-th-bg-tertiary text-th-text-secondary"
					: "bg-th-accent/10 text-th-accent"
			}`}
		>
			<Upload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
			<span className="truncate">
				{refusal ??
					(destPath
						? `Upload to ${shortenPath(destPath)}`
						: "Upload to project root")}
			</span>
		</div>
	);
}

function FilesTab({ onSelectFile, activeFilePath }: Props) {
	const queryClient = useQueryClient();
	// The same value the queue pins each upload to, rather than the router's copy
	// of it, so the tab and the store cannot disagree about which tree is current.
	const worktree = useWorktreeStore((state) => state.current);
	const [expandSignal, setExpandSignal] = useState(0);
	const [query, setQuery] = useState("");
	const [uploadDestPath, setUploadDestPath] = useState("");
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingUpload | null>(null);
	const uploads = useWorktreeUploads();

	const handleRefresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["contents"] });
		queryClient.invalidateQueries({ queryKey: [FILE_SEARCH_QUERY_KEY] });
		setExpandSignal((s) => s + 1);
	}, [queryClient]);

	const { isActive } = useSidebarRefresh("files", handleRefresh);

	const prevActiveRef = useRef(isActive);
	useEffect(() => {
		if (isActive && !prevActiveRef.current) {
			setExpandSignal((s) => s + 1);
		}
		prevActiveRef.current = isActive;
	}, [isActive]);

	const inputRef = useRef<HTMLInputElement>(null);
	const handleSelectFile = useCallback(
		(path: string) => {
			// Dismiss the mobile keyboard before the sidebar closes, otherwise it
			// lingers on top of the closing animation.
			inputRef.current?.blur();
			onSelectFile(path);
		},
		[onSelectFile],
	);

	const search = useFileSearch(query, isActive);
	// Driven by the input alone, not by focus: tapping an option chip blurs the
	// input, which would otherwise flash the file tree back on screen.
	const inSearchMode = search.status !== "idle";

	// A destination is a path within one worktree and means nothing in the next.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the setters are stable; worktree is the trigger, not a value the body reads
	useEffect(() => {
		setUploadDestPath("");
		setUploadError(null);
		setPending(null);
	}, [worktree]);

	// A watcher covers the destination only while its folder is expanded, so a
	// file dropped into a collapsed one would otherwise not appear until the
	// next refresh.
	useEffect(
		() =>
			onFileUploaded((destPath) => {
				queryClient.invalidateQueries({ queryKey: contentsQueryKey(destPath) });
			}),
		[queryClient],
	);

	const cachedEntries = useCallback(
		(dir: string): Entry[] | null => {
			const cached = queryClient.getQueryData<ContentsResponse>(
				contentsQueryKey(dir),
			);
			return Array.isArray(cached) ? cached : null;
		},
		[queryClient],
	);

	/**
	 * The destination, or the root if it is no longer there.
	 *
	 * A folder can be deleted or renamed after it was picked, and the endpoint
	 * does not create one. Falling back silently beats reporting it at the
	 * moment the user finally presses upload.
	 */
	const resolveDest = useCallback((): string => {
		if (!uploadDestPath) return "";
		const entries = cachedEntries(parentDir(uploadDestPath));
		// Nothing cached says nothing about the folder, so it is left alone.
		if (!entries) return uploadDestPath;
		const stillThere = entries.some(
			(entry) => entry.path === uploadDestPath && entry.type === "dir",
		);
		if (stillThere) return uploadDestPath;
		setUploadDestPath("");
		return "";
	}, [uploadDestPath, cachedEntries]);

	/** Names already spoken for in a directory, on disk or by the queue. */
	const takenNames = useCallback(
		(dir: string): Set<string> => {
			const taken = new Set<string>();
			for (const entry of cachedEntries(dir) ?? []) taken.add(entry.name);
			for (const item of uploads) {
				if (item.destPath !== dir) continue;
				// A cancelled or failed upload gave its name back.
				if (item.status === "cancelled" || item.status === "failed") continue;
				taken.add(item.name);
			}
			return taken;
		},
		[cachedEntries, uploads],
	);

	const queueBatch = useCallback(
		(batch: PendingUpload, choice: "skip" | "replace" | "keep-both") => {
			const taken = takenNames(batch.destPath);
			const uploadsToStart: NewUpload[] = [];

			for (const file of batch.files) {
				const collision = batch.conflicts.get(file) ?? "none";
				// A folder of that name is never replaced, whatever was chosen for
				// the files: writing over one would take its whole subtree with it.
				if (collision === "folder") {
					uploadsToStart.push({
						file,
						destPath: batch.destPath,
						blockedBy: "folder",
					});
					continue;
				}
				if (collision === "none") {
					taken.add(file.name);
					uploadsToStart.push({ file, destPath: batch.destPath });
					continue;
				}

				if (choice === "skip") continue;
				if (choice === "replace") {
					uploadsToStart.push({
						file,
						destPath: batch.destPath,
						overwrite: true,
					});
					continue;
				}
				// The endpoint cannot rename, so a second copy is a name chosen here.
				const name = nextAvailableName(file.name, taken);
				taken.add(name);
				uploadsToStart.push({ file, name, destPath: batch.destPath });
			}

			uploadActions.enqueue(uploadsToStart);
		},
		[takenNames],
	);

	/**
	 * Takes a batch as far as the queue, or as far as the question it raises.
	 *
	 * `refusal` is what the batch already lost on the way in — a dropped folder,
	 * say — and is shown unless something worse about the batch replaces it.
	 */
	const uploadInto = useCallback(
		(files: File[], destPath: string, refusal: string | null) => {
			// There is one place to hold a batch waiting on an answer, so a second
			// one would take the first's place without a word, dropping the files it
			// was holding. Refused here rather than at each entry point: every batch
			// arrives through this function, including the ones no dialog can stand
			// in front of — the picker is reachable by tabbing past the overlay.
			if (pending) {
				setUploadError(BATCH_AWAITING_ANSWER);
				return;
			}
			setUploadError(refusal);
			if (files.length === 0) return;
			if (files.length > MAX_FILES_PER_UPLOAD) {
				setUploadError(
					`Too many files. Upload up to ${MAX_FILES_PER_UPLOAD} at a time.`,
				);
				return;
			}

			const entries = cachedEntries(destPath);
			const conflicts = new Map<File, NameCollision>();
			for (const file of files) {
				conflicts.set(file, nameCollision(file.name, entries));
			}

			const batch: PendingUpload = { destPath, files, conflicts };
			// Asked once, before anything is sent, rather than interrupting a
			// transfer already in flight.
			if (files.some((file) => conflicts.get(file) === "file")) {
				setPending(batch);
				return;
			}
			queueBatch(batch, "skip");
		},
		[cachedEntries, queueBatch, pending],
	);

	const handlePickedFiles = useCallback(
		(files: File[]) => uploadInto(files, resolveDest(), null),
		[uploadInto, resolveDest],
	);

	/**
	 * Why a drag would be turned away, if it would be.
	 *
	 * A conflict dialog is a portal, and a portal's events still travel the React
	 * tree: its overlay stops clicks but not drops. `uploadInto` turns the batch
	 * away in either case; saying so on the bar while the drag is still up is
	 * better than accepting the drop and then answering it with a banner.
	 *
	 * Search results are a flat list of matches from everywhere, which has no
	 * answer to "into which folder"; there the upload button keeps working, since
	 * it aims at the destination already chosen.
	 */
	const dropRefusal = inSearchMode
		? "Exit search to upload files"
		: pending
			? "Finish answering before dropping more"
			: null;

	const treeWrapperRef = useRef<HTMLDivElement>(null);
	const drop = useFileDrop({
		enabled: dropRefusal === null,
		onDrop: useCallback(
			({ files, hadFolder, destPath }) => {
				// Dropping into a folder is at least as clear a statement of where the
				// user is working as tapping one, so the upload button follows it.
				setUploadDestPath(destPath);
				uploadInto(files, destPath, hadFolder ? FOLDER_DROP_REFUSED : null);
			},
			[uploadInto],
		),
		// `PullToRefreshify` owns the element that scrolls and does not forward a
		// ref to it; it is the single child this wrapper renders.
		getScrollContainer: useCallback(() => {
			const child = treeWrapperRef.current?.firstElementChild;
			return child instanceof HTMLElement ? child : null;
		}, []),
	});

	const answerConflict = useCallback(
		(choice: "skip" | "replace" | "keep-both") => {
			if (!pending) return;
			setPending(null);
			// That refusal was an instruction, and this is it being carried out;
			// left standing it would read as an answer that did not register. Only
			// that one: a folder turned away on the way in is still true afterwards.
			setUploadError((shown) =>
				shown === BATCH_AWAITING_ANSWER ? null : shown,
			);
			queueBatch(pending, choice);
		},
		[pending, queueBatch],
	);

	const handleReplace = useCallback((item: UploadItem) => {
		uploadActions.retry(item.id, { overwrite: true });
	}, []);

	const handleKeepBoth = useCallback(
		(item: UploadItem) => {
			const taken = takenNames(item.destPath);
			// The name it failed under is taken by definition — by the folder that
			// blocked it, or by whatever the server's 409 found. Without this, a
			// collision the cached listing did not know about would be answered with
			// the very same name, and "Keep both" would fail again on every press.
			taken.add(item.name);
			uploadActions.retry(item.id, {
				name: nextAvailableName(item.name, taken),
				overwrite: false,
			});
		},
		[takenNames],
	);

	const pendingNames = pending
		? pending.files
				.filter((file) => pending.conflicts.get(file) === "file")
				.map((file) => file.name)
		: [];

	const acceptsDrop = drop.isDragging && dropRefusal === null;
	// While a drag is up, everything that is not the tree has to be transparent to
	// it: the cursor crossing a bar would otherwise resolve the destination back
	// to the root, with the bar still reading "Upload to src".
	const inertWhileDragging = drop.isDragging ? "pointer-events-none" : "";

	return (
		<div
			className={
				isActive
					? `flex flex-1 flex-col overflow-hidden ${
							acceptsDrop
								? // A ring rather than a border: a border takes a pixel from
									// the layout and would nudge the whole tree sideways the
									// moment a drag arrives.
									"bg-th-accent/5 ring-2 ring-th-accent ring-inset"
								: ""
						}`
					: "hidden"
			}
			{...drop.dropProps}
		>
			<FileSearchBar
				query={query}
				onQueryChange={setQuery}
				showOptions={inSearchMode}
				isSearching={search.isFetching}
				inputRef={inputRef}
				actions={
					<UploadButton destPath={uploadDestPath} onFiles={handlePickedFiles} />
				}
			/>

			{uploadError && (
				<div
					className={`shrink-0 border-b border-th-error/20 bg-th-error/10 px-4 py-2 text-sm text-th-error ${inertWhileDragging}`}
				>
					{uploadError}
				</div>
			)}

			{/* Both branches stay mounted so leaving search restores the tree's
			    expansion state, scroll position and FS watch subscriptions. */}
			<div
				ref={treeWrapperRef}
				className={inSearchMode ? "hidden" : "flex min-h-0 flex-1 flex-col"}
			>
				<PullToRefresh onRefresh={handleRefresh}>
					<FileTree
						onSelectFile={onSelectFile}
						activeFilePath={activeFilePath}
						expandSignal={expandSignal}
						watchEnabled={isActive}
						uploadDestPath={uploadDestPath}
						onSelectDir={setUploadDestPath}
						dropTargetPath={acceptsDrop ? drop.destPath : null}
						springOpenPath={drop.springOpenPath}
					/>
				</PullToRefresh>
			</div>

			<div className={inSearchMode ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
				<FileSearchResults
					search={search}
					onSelectFile={handleSelectFile}
					activeFilePath={activeFilePath}
				/>
			</div>

			<div className={`shrink-0 ${inertWhileDragging}`}>
				<UploadQueue
					items={uploads}
					onReplace={handleReplace}
					onKeepBoth={handleKeepBoth}
				/>
			</div>

			{drop.isDragging && (
				<DropTargetBar destPath={drop.destPath ?? ""} refusal={dropRefusal} />
			)}

			{pending && (
				<UploadConflictDialog
					names={pendingNames}
					total={pending.files.length}
					destPath={pending.destPath}
					onKeepBoth={() => answerConflict("keep-both")}
					onReplace={() => answerConflict("replace")}
					onSkip={() => answerConflict("skip")}
				/>
			)}
		</div>
	);
}

export default FilesTab;
