import { ConfirmDialog } from "@pockode/shared";
import {
	AlertCircle,
	Check,
	Eye,
	Loader2,
	MessageSquare,
	Pencil,
	Trash2,
	X,
} from "lucide-react";
import { Fragment, useCallback, useMemo, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { useInlineEdit } from "../../hooks/useInlineEdit";
import { useRoleNameMap } from "../../hooks/useRoleNameMap";
import { useWorkDetailSubscription } from "../../hooks/useWorkDetailSubscription";
import type { Activity } from "../../lib/activity";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { requestAnswerPanel } from "../../lib/answerIntent";
import { roleAcceptsWorkType, WORK_TYPE_PLURAL } from "../../lib/roleWorkType";
import {
	selectSessionTitle,
	UNLISTED_SESSION_NAME,
	useSessionStore,
} from "../../lib/sessionStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import type { PendingQuestion } from "../../types/message";
import type { Comment, Work, WorkListItem, WorkType } from "../../types/work";
import { formatStepCount, getStepProgress } from "../../utils/workSteps";
import PageHeader from "../Layout/PageHeader";
import { ActivityBadge, MarkdownContent, RecommendedTag } from "../ui";
import BottomActionBar from "../ui/BottomActionBar";
import { inputClass } from "../ui/inputClass";
import { WorktreeBadge } from "../Worktree";
import RoleSelect from "./RoleSelect";
import StepList from "./StepList";
import {
	ACTION_ICON,
	ACTION_LABEL,
	countActiveChildren,
	StopConfirm,
	useWorkCommand,
} from "./WorkPrimaryAction";
import WorkRow from "./WorkRow";
import WorkUsageSection from "./WorkUsageSection";

interface Props {
	workId: string;
	onBack: () => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
	onOpenWorkDetail: (workId: string) => void;
}

/**
 * One page per work: moving to a parent or child renders this same element with
 * another id, and a reused page would carry the last work's scroll position,
 * half-finished edits, open sheets and error lines onto the next one. Keyed
 * here rather than at the call site so no entry point can forget it.
 */
export default function WorkDetailOverlay(props: Props) {
	return <WorkDetailPage key={props.workId} {...props} />;
}

function WorkDetailPage({
	workId,
	onBack,
	onNavigateToSession,
	onOpenWorkDetail,
}: Props) {
	// Children and parent come with the detail, not out of the work list: that
	// list is the `Current` segment and holds no closed work, so a closed story
	// read from the archive would look childless (docs/list-paging-ui.md §2.2).
	const {
		work,
		activity,
		comments,
		usage,
		children,
		parent,
		pendingQuestions,
		loading,
		error,
	} = useWorkDetailSubscription(workId);

	const roles = useAgentRoleStore((s) => s.roles);
	const roleNameMap = useRoleNameMap();
	const role = useMemo(
		() =>
			work?.agent_role_id
				? roles.find((r) => r.id === work.agent_role_id)
				: undefined,
		[roles, work?.agent_role_id],
	);

	if (loading) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<DetailHeader onBack={onBack} title={null} />
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-th-text-muted">
					<Loader2 className="size-5 animate-spin" />
					<p>Loading...</p>
				</div>
			</div>
		);
	}

	if (error || !work) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				{/* Not a skeleton: nothing is on its way that would say which kind
				    of work this is. */}
				<DetailHeader onBack={onBack} title="Work" />
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-th-text-muted">
					<AlertCircle className="size-5" />
					<p>{error ?? "Item not found"}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<DetailHeader
				onBack={parent ? () => onOpenWorkDetail(parent.id) : onBack}
				title={typeLabels[work.type]}
				backLabel={parent ? "Back to parent story" : "Back to project"}
			/>
			<div className="min-h-0 flex-1 overflow-auto">
				<div className="space-y-5 p-4">
					<div>
						{parent && (
							<button
								type="button"
								onClick={() => onOpenWorkDetail(parent.id)}
								className="mb-1 text-xs text-th-text-muted hover:text-th-accent"
							>
								{parent.title}
							</button>
						)}
						<InlineEditableTitle work={work} />
						<div className="mt-2 flex flex-wrap items-center gap-2">
							<ActivityBadge activity={activity} />
							<WorktreeBadge work={work} className="max-w-[16rem]" />
						</div>
						<WaitLine work={work} />
						<WatcherLine
							work={work}
							onNavigateToSession={onNavigateToSession}
						/>
					</div>

					<PendingQuestionsSection
						work={work}
						questions={pendingQuestions}
						onNavigateToSession={onNavigateToSession}
					/>

					{/* What changes goes above what does not, the list page's
					    rule applied to one work: the tasks are where a running
					    story moves, the brief and the role are settled once it
					    starts. */}
					{work.type === "story" && (
						<ChildrenSection
							tasks={children}
							roleNameMap={roleNameMap}
							onOpenWorkDetail={onOpenWorkDetail}
							onNavigateToSession={onNavigateToSession}
						/>
					)}

					<InlineEditableBody work={work} />

					<RoleSection work={work} />

					<StepProgressSection work={work} role={role} />

					{usage && <WorkUsageSection type={work.type} usage={usage} />}

					<CommentsSection comments={comments} />
				</div>
			</div>

			<ActionBar
				work={work}
				activity={activity}
				tasks={children}
				onNavigateToSession={onNavigateToSession}
				onBack={onBack}
			/>
		</div>
	);
}

const typeLabels: Record<WorkType, string> = {
	story: "Story",
	task: "Task",
};

function DetailHeader({
	onBack,
	title,
	backLabel = "Back to project",
}: {
	onBack: () => void;
	/** `null` while the work has not arrived. */
	title: string | null;
	backLabel?: string;
}) {
	return (
		<PageHeader
			back={{ to: "parent", label: backLabel, onClick: onBack }}
			title={title}
		/>
	);
}

function ActionBar({
	work,
	activity,
	tasks,
	onNavigateToSession,
	onBack,
}: {
	work: Work;
	activity: Activity;
	/** This work's children, which decide what stopping it would cost. */
	tasks: WorkListItem[];
	onNavigateToSession: (sessionId: string, worktree: string) => void;
	onBack: () => void;
}) {
	const deleteWork = useWSStore((s) => s.actions.deleteWork);
	// Which button exists is the status's business and no one else's
	// (docs/lifecycle-ui.md §3): a control that appeared and vanished as turns
	// settled is one the user cannot aim at. The list row's icon-only button is
	// the same command, from the same hook — this page only has room for a label.
	const {
		action,
		busy,
		error: actionError,
		clearError,
		activate,
		confirm: stopConfirm,
		confirmed,
		cancel,
	} = useWorkCommand(
		{ id: work.id, status: work.status, activity },
		countActiveChildren(tasks),
	);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	// The bar has one line for failures and the newest one owns it, in both
	// directions: a Start that failed earlier must not be what the user reads
	// after a delete fails, and a delete that failed must not outlive the next
	// command.
	const handleAction = useCallback(() => {
		setDeleteError(null);
		activate();
	}, [activate]);

	const handleDelete = useCallback(async () => {
		clearError();
		try {
			await deleteWork(work.id);
			setShowDeleteConfirm(false);
			onBack();
		} catch (err) {
			setDeleteError(
				`Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
			);
			setShowDeleteConfirm(false);
		}
	}, [deleteWork, work.id, onBack, clearError]);

	const showChat = !!work.session_id;
	const canDelete = work.status !== "closed";
	const ActionIcon = ACTION_ICON[action];
	const isStop = action === "stop";

	const typeLabel = work.type === "story" ? "Story" : "Task";
	const childCount = tasks.length;
	// Deleting an active work is the one destructive action here that also kills
	// a process, and the dialog has to say the whole of what it does.
	const confirmMessage = [
		childCount > 0
			? `Delete "${work.title}" and its ${childCount} child task${childCount > 1 ? "s" : ""}? This cannot be undone.`
			: `Delete "${work.title}"? This cannot be undone.`,
		work.status === "active"
			? "Its session and its running agent will be deleted too."
			: null,
	]
		.filter(Boolean)
		.join(" ");

	const error = actionError ?? deleteError;

	return (
		<BottomActionBar>
			{error && (
				<p className="mb-1.5 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
			<div className="flex items-center gap-2">
				{/* Primary actions - left side */}
				<div className="flex flex-1 gap-2">
					<button
						type="button"
						onClick={handleAction}
						disabled={busy}
						className={`flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:opacity-50 ${isStop ? "bg-th-error/10 text-th-error" : "bg-th-accent text-th-accent-text"}`}
					>
						{busy ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<ActionIcon className="size-4" />
						)}
						{ACTION_LABEL[action]}
					</button>
					{showChat && (
						<button
							type="button"
							onClick={() =>
								onNavigateToSession(work.session_id ?? "", work.worktree ?? "")
							}
							className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-th-border text-sm font-medium text-th-text-primary hover:bg-th-bg-tertiary"
						>
							<MessageSquare className="size-4" />
							Open Chat
						</button>
					)}
				</div>

				{/* Delete button - right side */}
				{canDelete && (
					<button
						type="button"
						onClick={() => setShowDeleteConfirm(true)}
						className="flex size-[44px] shrink-0 items-center justify-center rounded-lg text-th-text-muted hover:bg-th-error/10 hover:text-th-error"
						aria-label={`Delete ${typeLabel}`}
					>
						<Trash2 className="size-5" />
					</button>
				)}
			</div>

			{stopConfirm && (
				<StopConfirm
					message={stopConfirm}
					onConfirm={confirmed}
					onCancel={cancel}
				/>
			)}

			{showDeleteConfirm && (
				<ConfirmDialog
					title={`Delete ${typeLabel}`}
					message={confirmMessage}
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setShowDeleteConfirm(false)}
				/>
			)}
		</BottomActionBar>
	);
}

/**
 * What the work is waiting for, under the badges.
 *
 * Only the wait on subtasks is left here. A wait on the *user* used to be the
 * agent's free-text reason, shown verbatim; it is now a question like any other
 * and is drawn by the section below, where it can be answered rather than only
 * read (docs/answering-ui.md §4).
 */
function WaitLine({ work }: { work: Work }) {
	if (work.status !== "active" || work.wait !== "child") return null;
	return (
		<p className="mt-2 text-xs text-th-text-secondary">
			Waiting for its subtasks to finish.
		</p>
	);
}

/**
 * Which chat this story wakes, and a way back to it.
 *
 * Shown whenever the detail names a watcher: closing releases the watch, so the
 * line goes by itself, and a stopped story keeps it because the watch outlives
 * a stop. There is no way to unwatch from here: the watch is the watching
 * agent's to release (story_unwatch), and a person who wants it gone tells
 * that chat.
 *
 * The chat is named from the session list rather than from a copy on the
 * detail, which would go stale on a rename. The list holds only the worktree in
 * view, so a watcher elsewhere is named by its worktree; either way the link
 * still opens it.
 */
function WatcherLine({
	work,
	onNavigateToSession,
}: {
	work: Work;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}) {
	// The worktree the session list is read out of, which is what decides
	// whether the list can name the watcher.
	const currentWorktree = useWorktreeStore((s) => s.current);
	const watcher = work.watcher;
	const watcherId = watcher?.session_id ?? "";
	const listedTitle = useSessionStore(selectSessionTitle(watcherId));

	if (!watcher) return null;
	const worktree = watcher.worktree ?? "";
	const name =
		worktree === currentWorktree
			? (listedTitle ?? UNLISTED_SESSION_NAME)
			: `a session in ${worktree || "main"}`;

	return (
		<div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-th-text-secondary">
			<Eye className="size-3 shrink-0 text-th-text-muted" aria-hidden="true" />
			<span className="shrink-0">Watched by</span>
			<button
				type="button"
				onClick={() => onNavigateToSession(watcher.session_id, worktree)}
				// The name truncates itself: `truncate` on the button would clip
				// `touch-target`'s overlay along with the text.
				className="touch-target flex min-w-0 max-w-[16rem] rounded text-th-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			>
				<span className="truncate">{name}</span>
			</button>
		</div>
	);
}

/**
 * The questions this work's session is waiting on, and one way to answer them.
 *
 * Read-only on purpose. Answering is a conversation — the user has to see what
 * happens next — so a form here would be a second answering path on a page with
 * no transcript to watch. The button navigates to the chat and opens the panel
 * there, which is the one surface that answers.
 *
 * Shown whenever the list is non-empty, under any status. That is a shorter
 * rule than "while active" and never wrong: closing a work withdraws its
 * questions, so the list is empty exactly when it should be, and a `stopped`
 * work with questions outstanding is precisely the one a person has been handed
 * back and needs to see them on.
 */
function PendingQuestionsSection({
	work,
	questions,
	onNavigateToSession,
}: {
	work: Work;
	questions: PendingQuestion[];
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}) {
	if (questions.length === 0) return null;
	const sessionId = work.session_id;

	const handleAnswer = () => {
		if (!sessionId) return;
		// The chat shows the panel by itself; what this adds is the question the
		// user pressed on — scrolled to, and read out. `Open Chat` below leads to
		// the same place, names none, and gets the oldest one without the caret
		// moving. One-shot and not a URL, so a reload of that chat does not
		// re-fire it.
		requestAnswerPanel({
			sessionId,
			requestId: questions[0].request_id,
		});
		onNavigateToSession(sessionId, work.worktree ?? "");
	};

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium uppercase text-th-text-muted">
				Waiting for your answer ({questions.length})
			</h3>
			<div className="space-y-2">
				{questions.map((question) => (
					<div
						key={question.request_id}
						className="rounded-lg bg-th-bg-secondary px-3 py-2"
					>
						{/* `max-w-full` because an inline-block sizes to its longest
						    word, and `break-words` only breaks one that is held in. */}
						<span className="inline-block max-w-full break-words rounded bg-th-accent/20 px-1.5 py-0.5 text-xs text-th-text-primary">
							{question.header}
						</span>
						{/* Markdown, as the answer panel draws the same question
						    (`QuestionForm`); option labels stay plain there too. */}
						<MarkdownContent
							content={question.question}
							className="prose-inherit-color mt-1 overflow-x-auto break-words text-th-text-primary"
						/>
						{(question.options ?? []).length > 0 && (
							<p className="mt-1 break-words text-xs text-th-text-muted">
								{(question.options ?? []).map((option, i) => (
									<Fragment key={option.label}>
										{i > 0 && " · "}
										{option.label}
										{option.recommended && <RecommendedTag />}
									</Fragment>
								))}
							</p>
						)}
					</div>
				))}
			</div>
			{sessionId && (
				<button
					type="button"
					onClick={handleAnswer}
					className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text"
				>
					<MessageSquare className="size-4" />
					Answer
				</button>
			)}
		</div>
	);
}

function InlineEditableTitle({ work }: { work: Work }) {
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const {
		editing,
		setEditing,
		value,
		setValue,
		saving,
		error,
		ref,
		save,
		cancel,
	} = useInlineEdit<HTMLInputElement>({
		initialValue: work.title,
		onSave: useCallback(
			(trimmed: string) => updateWork({ id: work.id, title: trimmed }),
			[updateWork, work.id],
		),
	});

	if (editing) {
		return (
			<div>
				<div className="flex items-center gap-2">
					<input
						ref={ref}
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") save();
							if (e.key === "Escape") cancel();
						}}
						disabled={saving}
						className={`min-w-0 flex-1 rounded-lg bg-th-bg-primary px-3 py-2 text-lg font-bold text-th-text-primary ${inputClass}`}
					/>
					<button
						type="button"
						onClick={save}
						disabled={saving || !value.trim()}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-success hover:bg-th-bg-tertiary disabled:opacity-50"
						aria-label="Save"
					>
						{saving ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Check className="size-4" />
						)}
					</button>
					<button
						type="button"
						onClick={cancel}
						disabled={saving}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted hover:bg-th-bg-tertiary"
						aria-label="Cancel"
					>
						<X className="size-4" />
					</button>
				</div>
				{error && (
					<p className="mt-1 text-xs text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="group flex items-start gap-1">
			<h2 className="min-w-0 flex-1 text-lg font-bold text-th-text-primary">
				{work.title}
			</h2>
			<button
				type="button"
				onClick={() => setEditing(true)}
				className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-th-text-muted opacity-80 transition-opacity hover:opacity-100 hover:bg-th-bg-tertiary hover:text-th-text-primary"
				aria-label="Edit title"
			>
				<Pencil className="size-4" />
			</button>
		</div>
	);
}

function RoleSection({ work }: { work: Work }) {
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const roles = useAgentRoleStore((s) => s.roles);
	const [editingRole, setEditingRole] = useState(false);
	const [savingRole, setSavingRole] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const role = useMemo(
		() =>
			work.agent_role_id
				? roles.find((r) => r.id === work.agent_role_id)
				: undefined,
		[work.agent_role_id, roles],
	);
	const otherType: WorkType = work.type === "story" ? "task" : "story";
	// Legal on the server's side — assignments are checked when made, not kept
	// in step with later restrictions — so this is said, not flagged as wrong.
	const mismatch =
		role && !roleAcceptsWorkType(role, work.type)
			? `${role.name} only takes ${WORK_TYPE_PLURAL[otherType]}. It stays on this ${work.type} until you change it.`
			: null;
	// An empty list says nothing: the store empties it on every reconnect, and
	// with no roles at all "set one to take tasks" names a role that is not there.
	const noRoleTakesType =
		roles.length > 0 && !roles.some((r) => roleAcceptsWorkType(r, work.type));

	const handleRoleChange = useCallback(
		async (newRoleId: string) => {
			if (!newRoleId || newRoleId === work.agent_role_id) {
				setEditingRole(false);
				return;
			}
			setError(null);
			setSavingRole(true);
			try {
				await updateWork({ id: work.id, agent_role_id: newRoleId });
				setEditingRole(false);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to update role");
			} finally {
				setSavingRole(false);
			}
		},
		[work.id, work.agent_role_id, updateWork],
	);

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
				Role
			</h3>
			{editingRole ? (
				<>
					<div className="flex items-center gap-2">
						<RoleSelect
							value={work.agent_role_id ?? ""}
							workType={work.type}
							onChange={handleRoleChange}
							emptyLabel={work.agent_role_id ? undefined : "Select role..."}
							onBlur={() => {
								if (!savingRole) setEditingRole(false);
							}}
							disabled={savingRole}
							autoFocus
						/>
						{savingRole && (
							<Loader2 className="size-4 animate-spin text-th-text-muted" />
						)}
					</div>
					{noRoleTakesType && (
						<p className="mt-1 text-xs text-th-text-muted">
							No role takes {WORK_TYPE_PLURAL[work.type]}. Set one to take{" "}
							{WORK_TYPE_PLURAL[work.type]} in Agent Roles.
						</p>
					)}
				</>
			) : (
				<>
					<button
						type="button"
						onClick={() => setEditingRole(true)}
						className="group flex min-h-[44px] items-center gap-1.5 text-sm text-th-text-secondary hover:text-th-accent"
					>
						<span>{role?.name ?? "—"}</span>
						<Pencil className="size-3.5 text-th-text-muted opacity-80 group-hover:opacity-100" />
					</button>
					{mismatch && <p className="text-xs text-th-text-muted">{mismatch}</p>}
				</>
			)}
			{error && (
				<p className="mt-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

function InlineEditableBody({ work }: { work: Work }) {
	const updateWork = useWSStore((s) => s.actions.updateWork);
	const {
		editing,
		setEditing,
		value,
		setValue,
		saving,
		error,
		ref,
		save,
		cancel,
	} = useInlineEdit<HTMLTextAreaElement>({
		initialValue: work.body ?? "",
		onSave: useCallback(
			(trimmed: string) => updateWork({ id: work.id, body: trimmed }),
			[updateWork, work.id],
		),
		allowEmpty: true,
	});

	if (editing) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
					Description
				</h3>
				<TextareaAutosize
					ref={ref}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape") cancel();
					}}
					disabled={saving}
					placeholder="Add description..."
					minRows={3}
					className={`w-full resize-none rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
				/>
				<div className="mt-2 flex items-center gap-2">
					<button
						type="button"
						onClick={save}
						disabled={saving}
						className="min-h-[44px] rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text disabled:opacity-50"
					>
						{saving ? "Saving..." : "Save"}
					</button>
					<button
						type="button"
						onClick={cancel}
						disabled={saving}
						className="min-h-[44px] rounded-lg px-4 text-sm text-th-text-muted hover:bg-th-bg-tertiary"
					>
						Cancel
					</button>
				</div>
				{error && (
					<p className="mt-1 text-xs text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		);
	}

	if (!work.body) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
					Description
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="min-h-[44px] w-full rounded-lg border border-dashed border-th-border px-3 text-left text-sm text-th-text-muted hover:border-th-text-muted hover:text-th-text-secondary"
				>
					Add description...
				</button>
			</div>
		);
	}

	return (
		<div>
			<div className="group flex items-center justify-between mb-1">
				<h3 className="text-xs font-medium text-th-text-muted uppercase">
					Description
				</h3>
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted opacity-80 transition-opacity hover:opacity-100 hover:bg-th-bg-tertiary hover:text-th-text-primary"
					aria-label="Edit description"
				>
					<Pencil className="size-3.5" />
				</button>
			</div>
			{/* `.code-block` leaves sideways scrolling to an ancestor; without this
			    one a wide line would slide the whole page. */}
			<div className="overflow-x-auto rounded-lg bg-th-bg-secondary px-3 py-2">
				<MarkdownContent content={work.body} />
			</div>
		</div>
	);
}

function ChildrenSection({
	tasks,
	roleNameMap,
	onOpenWorkDetail,
	onNavigateToSession,
}: {
	tasks: WorkListItem[];
	roleNameMap: Map<string, string>;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}) {
	const closedTasks = tasks.filter((t) => t.status === "closed").length;
	// The active count is what makes a rejected `step_done` legible without a
	// second explanation: a story that will not finish says here how many
	// subtasks it is still waiting on (docs/lifecycle-ui.md §6.2).
	const activeTasks = countActiveChildren(tasks);

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
				Tasks{" "}
				{tasks.length > 0 && (
					<span>
						({closedTasks}/{tasks.length})
						{activeTasks > 0 && (
							<>
								{" "}
								<span aria-hidden="true">&middot;</span> {activeTasks} active
							</>
						)}
					</span>
				)}
			</h3>
			{tasks.length === 0 ? (
				<p className="py-2 text-sm text-th-text-muted">No tasks yet</p>
			) : (
				<div className="space-y-2">
					{tasks.map((child) => (
						// The same row the project list draws, minus its parent slot:
						// every row here is a task of the story on screen
						// (docs/project-ui.md §3.1). Under the Tasks heading, so `h4`.
						<WorkRow
							key={child.id}
							work={child}
							roleName={
								child.agent_role_id
									? roleNameMap.get(child.agent_role_id)
									: undefined
							}
							headingLevel={4}
							onOpen={onOpenWorkDetail}
							onOpenChat={onNavigateToSession}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function CommentsSection({ comments }: { comments: Comment[] }) {
	if (comments.length === 0) {
		return (
			<div>
				<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
					Comments
				</h3>
				<p className="py-2 text-sm text-th-text-muted">No comments yet</p>
			</div>
		);
	}

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium text-th-text-muted uppercase">
				Comments ({comments.length})
			</h3>
			<div className="space-y-3">
				{comments.map((comment) => (
					<CommentItem key={comment.id} comment={comment} />
				))}
			</div>
		</div>
	);
}

function CommentItem({ comment }: { comment: Comment }) {
	return (
		<div className="rounded-lg bg-th-bg-secondary px-3 py-2">
			<MarkdownContent content={comment.body} />
			<p className="mt-1.5 text-xs text-th-text-muted">
				{formatCommentDate(comment.created_at)}
			</p>
		</div>
	);
}

function formatCommentDate(dateString: string): string {
	const date = new Date(dateString);
	const now = new Date();
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	}
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function StepProgressSection({
	work,
	role,
}: {
	work: Work;
	role: AgentRole | undefined;
}) {
	const steps = role?.steps ?? [];
	const progress = getStepProgress(work, role);
	const currentStep = progress?.currentStep ?? 0;

	if (steps.length === 0) return null;

	return (
		<div>
			<h3 className="mb-1 text-xs font-medium uppercase text-th-text-muted">
				Steps{" "}
				{progress && (
					<span
						className={
							progress.isComplete ? "text-th-success" : "text-th-accent"
						}
					>
						({formatStepCount(progress)})
					</span>
				)}
			</h3>
			<StepList
				steps={steps}
				currentStep={currentStep}
				workStatus={work.status}
				className="rounded-lg bg-th-bg-secondary px-3 py-2"
			/>
		</div>
	);
}
