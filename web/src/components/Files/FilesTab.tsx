import { ConfirmDialog } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Upload } from "lucide-react";
import {
	type ChangeEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
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
import { useWSStore } from "../../lib/wsStore";
import type { ContentsResponse, Entry, EntryType } from "../../types/contents";
import { isAtOrUnder, parentDir } from "../../utils/path";
import { useSidebarRefresh } from "../Layout";
import { PullToRefresh } from "../ui";
import FileEntryMenu, { ROOT_ENTRY } from "./FileEntryMenu";
import FileSearchBar from "./FileSearchBar";
import FileSearchResults from "./FileSearchResults";
import FileTree from "./FileTree";
import NewEntryDialog from "./NewEntryDialog";
import UploadConflictDialog from "./UploadConflictDialog";
import UploadQueue from "./UploadQueue";
import { FOLDER_DROP_REFUSED, useFileDrop } from "./useFileDrop";

interface Props {
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
	/** Closes the content area when the file it shows is deleted from here. */
	onCloseFile: () => void;
}

/** An entry being named, before it exists anywhere. */
interface Naming {
	/** Directory it will be created in; empty is the workspace root. */
	dir: string;
	type: EntryType;
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

function FilesTab({ onSelectFile, activeFilePath, onCloseFile }: Props) {
	const queryClient = useQueryClient();
	const createFile = useWSStore((state) => state.actions.createFile);
	const deleteFile = useWSStore((state) => state.actions.deleteFile);
	// The same value the queue pins each upload to, rather than the router's copy
	// of it, so the tab and the store cannot disagree about which tree is current.
	const worktree = useWorktreeStore((state) => state.current);
	const [expandSignal, setExpandSignal] = useState(0);
	const [query, setQuery] = useState("");
	const [actionError, setActionError] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingUpload | null>(null);
	const [menuTarget, setMenuTarget] = useState<Entry | null>(null);
	const [naming, setNaming] = useState<Naming | null>(null);
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
	// A folder the tree has to open to show what was just created in it.
	const [forceOpenPath, setForceOpenPath] = useState<string | null>(null);
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

	// Every one of these is about an entry of the tree being left behind, or
	// about something that happened to one; none of it survives the switch.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the setters are stable; worktree is the trigger, not a value the body reads
	useEffect(() => {
		setActionError(null);
		setPending(null);
		setMenuTarget(null);
		setNaming(null);
		setCreateError(null);
		setDeleteTarget(null);
		setForceOpenPath(null);
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
				setActionError(BATCH_AWAITING_ANSWER);
				return;
			}
			setActionError(refusal);
			if (files.length === 0) return;
			if (files.length > MAX_FILES_PER_UPLOAD) {
				setActionError(
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

	// The picker opened from the menu, which unmounts with the sheet the moment
	// it is chosen from and so cannot hold an input of its own.
	const menuPickerRef = useRef<HTMLInputElement>(null);
	const menuDestRef = useRef("");

	const handleMenuPicked = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(event.target.files ?? []);
			// Cleared so that picking the same file twice in a row still fires.
			event.target.value = "";
			if (files.length > 0) uploadInto(files, menuDestRef.current, null);
		},
		[uploadInto],
	);

	const handleMenuUpload = useCallback(() => {
		if (!menuTarget) return;
		menuDestRef.current = menuTarget.path;
		// Opened before the sheet closes and without awaiting anything: iOS Safari
		// only lets a picker open from the same synchronous stack as the tap.
		menuPickerRef.current?.click();
		setMenuTarget(null);
	}, [menuTarget]);

	const openNaming = useCallback(
		(type: EntryType) => {
			if (!menuTarget) return;
			setMenuTarget(null);
			setCreateError(null);
			// Retired before the next one is asked for: assigning the same path
			// twice does not re-run the tree's effect, so a folder collapsed since
			// the last creation would stay shut over this one.
			setForceOpenPath(null);
			setNaming({ dir: menuTarget.path, type });
		},
		[menuTarget],
	);

	// Only for the immediate answer: a folder that has never been expanded has no
	// listing to check against, which is why the server is the one that decides.
	const namingContents = useContents(naming?.dir ?? "", naming !== null);
	const namingTaken =
		naming && !namingContents.isPending ? takenNames(naming.dir) : null;

	const handleCreate = useCallback(
		async (name: string) => {
			if (!naming || creating) return;
			const { dir, type } = naming;
			const path = dir ? `${dir}/${name}` : name;

			setCreating(true);
			setCreateError(null);
			try {
				await createFile(path, type);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// A name already taken is answerable right here, by typing another
				// one, so the dialog stays up holding it. Anything else is about the
				// request rather than the name and leaves with the dialog.
				if (message.includes("already exists")) {
					setCreateError(message);
				} else {
					setNaming(null);
					setActionError(message);
				}
				return;
			} finally {
				setCreating(false);
			}

			setNaming(null);
			queryClient.invalidateQueries({ queryKey: contentsQueryKey(dir) });
			// A folder that stays closed over what was just made in it is the same
			// as the creation having done nothing.
			if (dir) setForceOpenPath(dir);
		},
		[naming, creating, createFile, queryClient],
	);

	const handleDelete = useCallback(async () => {
		if (!deleteTarget) return;
		const { path } = deleteTarget;
		setDeleteTarget(null);

		try {
			await deleteFile(path);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
			return;
		}

		queryClient.invalidateQueries({
			queryKey: contentsQueryKey(parentDir(path)),
		});
		// Dropped rather than invalidated: every listing at or under this path is
		// about something that is gone, so refetching them would only collect one
		// "not found" per folder. A file is its own one-entry subtree here, and
		// dropping its cache keeps a reopened path from showing what was deleted.
		queryClient.removeQueries({
			predicate: ({ queryKey }) => {
				const [scope, key] = queryKey;
				if (scope !== "contents" || typeof key !== "string") return false;
				return isAtOrUnder(key, path);
			},
		});
		// The overlay reads the file's own path, which invalidating the folder
		// around it does not touch; left open it would go on showing the contents
		// of a file that no longer exists.
		if (activeFilePath && isAtOrUnder(activeFilePath, path)) onCloseFile();
	}, [deleteTarget, deleteFile, queryClient, activeFilePath, onCloseFile]);

	/**
	 * Why a drag would be turned away, if it would be.
	 *
	 * A conflict dialog is a portal, and a portal's events still travel the React
	 * tree: its overlay stops clicks but not drops. `uploadInto` turns the batch
	 * away in either case; saying so on the bar while the drag is still up is
	 * better than accepting the drop and then answering it with a banner.
	 *
	 * Search results are a flat list of matches from everywhere, which has no
	 * answer to "into which folder". Uploading stays reachable under search all
	 * the same, through the root's `…`, whose target is never in doubt.
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
			setActionError((shown) =>
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
					// The root has no row of its own, so its menu hangs here. Still
					// reachable in search mode, where the tree is hidden but the
					// target — the root — is not in doubt.
					<button
						type="button"
						onClick={() => setMenuTarget(ROOT_ENTRY)}
						aria-label="Project root actions"
						aria-haspopup="dialog"
						aria-expanded={menuTarget?.path === ""}
						className="flex size-9 shrink-0 pointer-coarse:size-11 items-center justify-center rounded-full text-th-text-muted transition-colors hover:bg-th-bg-tertiary hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95"
					>
						<MoreHorizontal className="h-4 w-4" aria-hidden="true" />
					</button>
				}
			/>

			{actionError && (
				<div
					className={`shrink-0 border-b border-th-error/20 bg-th-error/10 px-4 py-2 text-sm text-th-error ${inertWhileDragging}`}
				>
					{actionError}
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
						onOpenMenu={setMenuTarget}
						menuPath={menuTarget?.path ?? null}
						dropTargetPath={acceptsDrop ? drop.destPath : null}
						springOpenPath={drop.springOpenPath}
						forceOpenPath={forceOpenPath}
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

			<input
				ref={menuPickerRef}
				type="file"
				multiple
				onChange={handleMenuPicked}
				className="hidden"
				tabIndex={-1}
				aria-hidden="true"
			/>

			{menuTarget && (
				<FileEntryMenu
					entry={menuTarget}
					onClose={() => setMenuTarget(null)}
					onUpload={handleMenuUpload}
					onNewFile={() => openNaming("file")}
					onNewFolder={() => openNaming("dir")}
					onDelete={() => {
						setDeleteTarget(menuTarget);
						setMenuTarget(null);
					}}
				/>
			)}

			{naming && (
				<NewEntryDialog
					type={naming.type}
					dir={naming.dir}
					takenNames={namingTaken}
					submitting={creating}
					serverError={createError}
					onCancel={() => setNaming(null)}
					onSubmit={handleCreate}
				/>
			)}

			{deleteTarget && (
				<ConfirmDialog
					title={
						deleteTarget.type === "dir" ? "Delete folder?" : "Delete file?"
					}
					message={
						deleteTarget.type === "dir"
							? `This will delete "${deleteTarget.path}" and everything inside it. This action cannot be undone.`
							: `This will delete "${deleteTarget.path}". This action cannot be undone.`
					}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setDeleteTarget(null)}
				/>
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
