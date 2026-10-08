import { ConfirmDialog } from "@pockode/shared";
import { AlertCircle, ChevronRight, Loader2, Plus } from "lucide-react";
import { type ReactNode, useCallback, useId, useState } from "react";
import { useGlobalSettingsStatus } from "../../hooks/useGlobalSettingsStatus";
import { describeEngine } from "../../lib/agentOptions";
import {
	useEffortsForAgent,
	useModelsForAgent,
} from "../../lib/agentOptionsStore";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { getAgentLabel } from "../../lib/agentType";
import { isDefaultStoryRole, resolveInitialRole } from "../../lib/initialRole";
import { markdownExcerpt } from "../../lib/markdownExcerpt";
import {
	RUNS_CHOICES,
	type RunsChoice,
	roleAcceptsWorkType,
} from "../../lib/roleWorkType";
import { useSettingsStore } from "../../lib/settingsStore";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import { countOf } from "../../utils/plural";
import PageHeader from "../Layout/PageHeader";
import BottomActionBar from "../ui/BottomActionBar";
import ListGroupHeading from "../ui/ListGroupHeading";
import SettingsLoadError from "../ui/SettingsLoadError";
import Skeleton from "../ui/Skeleton";
import Tag from "../ui/Tag";
import CreateAgentRoleSheet from "./CreateAgentRoleSheet";
import RoleSelect from "./RoleSelect";

interface Props {
	onBack: () => void;
	onOpenAgentRoleDetail: (roleId: string) => void;
}

const GROUP_LABEL: Record<RunsChoice, string> = {
	story: "Story roles",
	task: "Task roles",
	"": "Story & task roles",
};

/**
 * Every agent role, grouped by what it runs, under the one setting that is
 * about the set of them: which role new stories start with. Creating is the
 * frequent action and sits where `New Story` does on the project page;
 * putting every role back is the rare, destructive one and sits at the end of
 * the list.
 *
 * Every slot, control and placeholder here is argued for in
 * docs/agent-roles-ui.md.
 */
export default function AgentRoleListOverlay({
	onBack,
	onOpenAgentRoleDetail,
}: Props) {
	const roles = useAgentRoleStore((s) => s.roles);
	const workRefCounts = useAgentRoleStore((s) => s.workRefCounts);
	const isLoading = useAgentRoleStore((s) => s.isLoading);
	const error = useAgentRoleStore((s) => s.error);

	const defaultRoleId = useSettingsStore(
		(s) => s.settings?.default_agent_role_id ?? "",
	);
	// Only the default story role waits on the settings snapshot. The list
	// itself comes from the agent role subscription, a separate wait with its
	// own loading and error states, so everything else here stays usable.
	const { valueState } = useGlobalSettingsStatus();

	const [creating, setCreating] = useState(false);
	const handleCreated = useCallback(
		(roleId: string) => {
			setCreating(false);
			onOpenAgentRoleDetail(roleId);
		},
		[onOpenAgentRoleDetail],
	);

	const resetAgentRoleDefaults = useWSStore(
		(s) => s.actions.resetAgentRoleDefaults,
	);
	const [showReset, setShowReset] = useState(false);
	const [resetError, setResetError] = useState<string | null>(null);

	const handleReset = useCallback(async () => {
		setResetError(null);
		try {
			await resetAgentRoleDefaults();
			setShowReset(false);
		} catch (err) {
			setResetError(
				`Failed to reset: ${err instanceof Error ? err.message : String(err)}`,
			);
			setShowReset(false);
		}
	}, [resetAgentRoleDefaults]);

	const groups = RUNS_CHOICES.map((runs) => ({
		runs,
		rows: roles.filter((r) => (r.work_type ?? "") === runs),
	})).filter((g) => g.rows.length > 0);

	// Only a snapshot that has arrived may mark a row: before it, no row is the
	// default as far as anything on screen knows, and a guess would be the
	// reassuring one.
	const isMarkedDefault = (role: AgentRole) =>
		valueState === "known" && isDefaultStoryRole(role, defaultRoleId);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader back={{ to: "chat", onClick: onBack }} title="Agent Roles" />

			{/* No padding on the scroller itself: the group headings pin to its
			    padding edge, and rows would show through the strip above them. */}
			<div className="min-h-0 flex-1 overflow-auto">
				<div className="mx-auto max-w-2xl px-4 py-4">
					{isLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="size-5 animate-spin text-th-text-muted" />
						</div>
					) : error ? (
						<div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-th-error">
							<AlertCircle className="size-5" />
							<p>{error}</p>
						</div>
					) : roles.length === 0 ? (
						// Reachable exactly one way — the user deleted the last role — so
						// both ways back are named, and the reset is offered right here.
						<div className="space-y-1 py-8 text-center text-sm">
							<p className="text-th-text-secondary">No agent roles</p>
							<p className="text-th-text-muted">
								Create one with the button below, or reset to the built-in
								roles.
							</p>
							<button
								type="button"
								onClick={() => setShowReset(true)}
								className="mt-3 inline-flex min-h-[44px] items-center rounded-lg bg-th-bg-tertiary px-4 text-sm text-th-text-primary hover:opacity-90"
							>
								Reset to defaults
							</button>
						</div>
					) : (
						<>
							<DefaultStoryRoleField
								roles={roles}
								defaultRoleId={defaultRoleId}
							/>

							<div className="mt-6 space-y-4">
								{groups.map(({ runs, rows }) => (
									<section key={runs || "both"}>
										<ListGroupHeading
											label={GROUP_LABEL[runs]}
											count={rows.length}
										/>
										{/* Space, not a border or a fill, is what separates one
										    card from the next: the card's own fill is worth
										    ~1.05 against this page (docs/project-ui.md §3). */}
										<div className="space-y-2">
											{rows.map((role) => (
												<RoleRow
													key={role.id}
													role={role}
													workRefCount={workRefCounts[role.id] ?? 0}
													isDefault={isMarkedDefault(role)}
													onOpenDetail={onOpenAgentRoleDetail}
												/>
											))}
										</div>
									</section>
								))}
							</div>

							<div className="mt-6 border-t border-th-border pt-4">
								<button
									type="button"
									onClick={() => setShowReset(true)}
									// No icon and muted rather than error-coloured: `text-th-error`
									// fails AA 4.5 in the five light themes (docs/project-ui.md §3
									// measures it), so red would say nothing in half of them, and
									// the confirm dialog is what carries the weight of a
									// destructive action.
									className="flex min-h-[44px] w-full items-center rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
								>
									Reset to defaults
								</button>
								<p className="px-3 text-xs text-th-text-muted">
									Replaces every role with the built-in set.
								</p>
							</div>
						</>
					)}

					{/* Outside every branch above: a reset in flight when the socket
					    drops takes the list back to loading, and the button that raised
					    this with it — leaving the failure with nowhere to be read. */}
					{resetError && (
						<p className="px-3 py-1 text-xs text-th-error" role="alert">
							{resetError}
						</p>
					)}
				</div>
			</div>

			{/* Usable while the list loads or fails, as `New Story` is: creating does
			    not depend on the list, and a failure is reported in the sheet. */}
			<BottomActionBar>
				<button
					type="button"
					onClick={() => setCreating(true)}
					className="mx-auto flex min-h-[44px] w-full max-w-2xl items-center justify-center gap-2 rounded-lg bg-th-accent text-sm font-medium text-th-accent-text"
				>
					<Plus className="size-4" />
					New Role
				</button>
			</BottomActionBar>

			{creating && (
				<CreateAgentRoleSheet
					onClose={() => setCreating(false)}
					onCreated={handleCreated}
				/>
			)}

			{showReset && (
				<ConfirmDialog
					title="Reset agent roles"
					message="Replace every role with the built-in set? Custom roles and edits will be lost."
					confirmLabel="Reset"
					variant="danger"
					onConfirm={handleReset}
					onCancel={() => setShowReset(false)}
				/>
			)}
		</div>
	);
}

/**
 * The only control for the default story role. It offers only roles that run
 * stories: the server refuses any other as the default.
 */
function DefaultStoryRoleField({
	roles,
	defaultRoleId,
}: {
	roles: AgentRole[];
	defaultRoleId: string;
}) {
	const fieldId = useId();
	const updateSettings = useWSStore((s) => s.actions.updateSettings);
	const { valueState } = useGlobalSettingsStatus();
	const [error, setError] = useState<string | null>(null);

	const select = useCallback(
		async (roleId: string) => {
			setError(null);
			try {
				await updateSettings({ default_agent_role_id: roleId });
			} catch (err) {
				setError(
					err instanceof Error
						? err.message
						: "Failed to update default story role",
				);
			}
		},
		[updateSettings],
	);

	const runsStories = roles.some((r) => roleAcceptsWorkType(r, "story"));

	return (
		<section className="space-y-1.5">
			<h2 className="text-xs uppercase tracking-wider text-th-text-muted">
				<label htmlFor={fieldId}>Default story role</label>
			</h2>
			{/* The snapshot this field waits on, not the list. */}
			<SettingsLoadError />
			{valueState === "known" ? (
				<>
					<RoleSelect
						id={fieldId}
						value={defaultRoleId}
						onChange={select}
						emptyLabel="None"
						workType="story"
						disabled={!runsStories}
					/>
					<p className="text-xs text-th-text-muted">
						{describeNewStory(roles, defaultRoleId)}
					</p>
				</>
			) : (
				valueState === "pending" && (
					// Never "None" first: that says there is no default story role, and
					// the user may well have one.
					<>
						<Skeleton
							className="h-11 w-full rounded-lg"
							label="Default story role: loading"
						/>
						<Skeleton className="h-3 w-2/3 rounded" />
					</>
				)
			)}
			{error && (
				<p className="text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

/**
 * What a new story starts with, in words. It describes `CreateStorySheet`'s
 * behaviour, so it asks the rule that form preselects with rather than
 * restating it. Called only with at least one role: with none, that form
 * refuses outright, and the empty list has already said so.
 */
function describeNewStory(roles: AgentRole[], defaultRoleId: string): string {
	const initial = resolveInitialRole(roles, defaultRoleId);
	if (initial && initial === defaultRoleId)
		return "New stories start with this role.";
	if (initial) {
		const name = roles.find((r) => r.id === initial)?.name ?? "";
		return `New stories use ${name}, the only role that runs stories.`;
	}
	if (!roles.some((r) => roleAcceptsWorkType(r, "story")))
		return "No role runs stories. Set a role to run Stories (or Both), or add one.";
	if (defaultRoleId) {
		// Both from a settings file edited by hand: the server clears the default
		// whenever a role stops running stories or is deleted.
		const stored = roles.find((r) => r.id === defaultRoleId);
		if (!stored)
			return "The saved default no longer exists. New stories ask which role to use.";
		return `${stored.name} can't run stories, so new stories ignore it. Pick a story role.`;
	}
	return "New stories ask which role to use.";
}

/**
 * One role as a card: its name, what it is for (the first line of its
 * prompt), and what is true of it. The group heading already says what it
 * runs, so the card does not repeat it.
 *
 * Deliberately without `WorkRow`'s 2px left edge: that edge carries a work's
 * state as hue, and a role has no state — a permanently neutral channel is a
 * channel that says nothing.
 */
function RoleRow({
	role,
	workRefCount,
	isDefault,
	onOpenDetail,
}: {
	role: AgentRole;
	/** How many work items name this role; 0 when none do. */
	workRefCount: number;
	isDefault: boolean;
	onOpenDetail: (roleId: string) => void;
}) {
	const models = useModelsForAgent(role.agent_type);
	const efforts = useEffortsForAgent(role.agent_type);
	// The same line the detail page's collapsed engine row prints, minus its
	// icon. The role's own record decides it: an absent agent stays "Follow
	// settings" here rather than being resolved against Settings, because the
	// value a missing snapshot resolves to is the reassuring one.
	const engine = describeEngine({
		agentLabel: role.agent_type ? getAgentLabel(role.agent_type) : null,
		models,
		model: role.model ?? "",
		efforts,
		effort: role.effort ?? "",
	});
	const excerpt = markdownExcerpt(role.role_prompt);

	// Fixed order, one appearance rule each, and the line clips from the right —
	// which puts the engine first and the count of other people's work last.
	// Nothing here is a placeholder: steps ride on the role record and the
	// reference counts arrive in the same reply the roles do.
	const slots: { key: string; node: ReactNode }[] = [
		{
			key: "engine",
			node: (
				<span
					className={
						engine.agentLabel ? "text-th-text-secondary" : "text-th-text-muted"
					}
				>
					{engine.text}
				</span>
			),
		},
	];
	if (role.steps && role.steps.length > 0) {
		slots.push({
			key: "steps",
			node: <span>{countOf(role.steps.length, "step")}</span>,
		});
	}
	if (workRefCount > 0) {
		slots.push({
			key: "refs",
			node: <span>{countOf(workRefCount, "work item")}</span>,
		});
	}

	return (
		// One button and nothing else in the card, so it is read as it is drawn:
		// name, tag, what it is for, what is true of it. Spans only — a button
		// holds phrasing content — with a spoken comma wherever a line break or
		// a drawn separator is all that parts two runs of text.
		<button
			type="button"
			onClick={() => onOpenDetail(role.id)}
			className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-th-border bg-th-bg-secondary px-3 py-2 text-left hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
		>
			<span className="block min-w-0 flex-1 space-y-0.5">
				<span className="flex items-center text-sm text-th-text-primary">
					<span className="truncate">{role.name}</span>
					{isDefault && <Tag label="Default" srSuffix=" story role" />}
				</span>
				<span className="sr-only">, </span>
				{excerpt ? (
					<span className="block truncate text-xs text-th-text-secondary">
						{excerpt}
					</span>
				) : (
					// A gap the user has to fill in, so it is shown rather than
					// collapsed away.
					<span className="block text-xs italic text-th-text-muted">
						No role prompt
					</span>
				)}
				<span className="sr-only">, </span>
				<span className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-th-text-muted">
					{slots.map((slot, i) => (
						// The separator belongs to the slot that follows it, so a slot
						// that is absent takes its separator with it.
						<span key={slot.key} className="flex shrink-0 items-center gap-1.5">
							{i > 0 && (
								<>
									<span aria-hidden="true">&middot;</span>
									<span className="sr-only">, </span>
								</>
							)}
							{slot.node}
						</span>
					))}
				</span>
			</span>
			<ChevronRight
				className="size-4 shrink-0 text-th-text-muted"
				aria-hidden="true"
			/>
		</button>
	);
}
