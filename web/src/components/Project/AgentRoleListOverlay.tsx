import { ConfirmDialog } from "@pockode/shared";
import { AlertCircle, Loader2, Plus, Star } from "lucide-react";
import { type ReactNode, useCallback, useId, useState } from "react";
import { useGlobalSettingsStatus } from "../../hooks/useGlobalSettingsStatus";
import { describeEngine } from "../../lib/agentOptions";
import {
	useEffortsForAgent,
	useModelsForAgent,
} from "../../lib/agentOptionsStore";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { getAgentLabel } from "../../lib/agentType";
import { resolveInitialRole } from "../../lib/initialRole";
import { useSettingsStore } from "../../lib/settingsStore";
import { type ValueState, waitingLabel } from "../../lib/valueState";
import { useWSStore } from "../../lib/wsStore";
import type { AgentRole } from "../../types/agentRole";
import BackToChatButton from "../ui/BackToChatButton";
import SettingsLoadError from "../ui/SettingsLoadError";
import Skeleton from "../ui/Skeleton";

interface Props {
	onBack: () => void;
	onOpenAgentRoleDetail: (roleId: string) => void;
}

/** `1 step` / `2 steps`, written out rather than left as `step(s)`. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * Two waits, one control: the settings snapshot says which role is the default,
 * the subscription says which roles exist, and the footer's field needs both.
 * The less certain of the two wins — a value that is never coming must not
 * pulse as though it were on its way.
 */
function combineStates(a: ValueState, b: ValueState): ValueState {
	if (a === "unavailable" || b === "unavailable") return "unavailable";
	if (a === "pending" || b === "pending") return "pending";
	return "known";
}

/**
 * Every agent role as a card, and — in the footer, outside the scroll region —
 * the three things that are about the set of roles rather than about one of
 * them: which one is the default, adding one, and putting them all back. The
 * footer sits outside the list so that a user who has deleted every role still
 * has Reset to defaults on screen.
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
	const updateSettings = useWSStore((s) => s.actions.updateSettings);
	// Only the stars and the footer's default role field wait on the settings
	// snapshot. The list itself comes from the agent role subscription, a
	// separate wait with its own loading and error states, so everything else
	// here stays usable.
	const { valueState } = useGlobalSettingsStatus();

	const listState: ValueState = error
		? "unavailable"
		: isLoading
			? "pending"
			: "known";

	const [defaultRoleError, setDefaultRoleError] = useState<string | null>(null);

	const setDefaultRole = useCallback(
		async (roleId: string) => {
			setDefaultRoleError(null);
			try {
				await updateSettings({ default_agent_role_id: roleId });
			} catch (err) {
				setDefaultRoleError(
					err instanceof Error ? err.message : "Failed to update default role",
				);
			}
		},
		[updateSettings],
	);

	// The star toggles; the footer's field selects. Both write the same setting
	// and both read it straight back, so the two can never disagree on screen.
	const handleToggleDefault = useCallback(
		(roleId: string) => setDefaultRole(defaultRoleId === roleId ? "" : roleId),
		[defaultRoleId, setDefaultRole],
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

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Navigation only: the one control that was up here acted on the whole
			    set of roles, and that is what the footer is for. */}
			<header className="flex items-center gap-1.5 border-b border-th-border bg-th-bg-secondary px-2 py-2">
				<BackToChatButton onClick={onBack} />
				<h1 className="flex-1 px-2 text-sm font-bold text-th-text-primary">
					Agent Roles
				</h1>
			</header>

			{/* The snapshot the stars and the footer field wait on, not the list. */}
			<SettingsLoadError className="px-3 py-1.5" />

			<div className="min-h-0 flex-1 overflow-auto p-2">
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
					// the way back is worth naming: the store seeds the defaults
					// whenever it starts out empty.
					<div className="space-y-1 py-8 text-center text-sm">
						<p className="text-th-text-secondary">No agent roles yet</p>
						<p className="text-th-text-muted">
							Add one below, or reset to the defaults.
						</p>
					</div>
				) : (
					// Space, not a border or a fill, is what separates one card from the
					// next: the card's own fill is worth ~1.05 against this page
					// (docs/project-ui.md §3).
					<div className="space-y-2">
						{roles.map((role) => (
							<RoleRow
								key={role.id}
								role={role}
								workRefCount={workRefCounts[role.id] ?? 0}
								isDefault={role.id === defaultRoleId}
								defaultState={valueState}
								onToggleDefault={handleToggleDefault}
								onOpenDetail={onOpenAgentRoleDetail}
							/>
						))}
					</div>
				)}
			</div>

			<div className="border-t border-th-border p-2">
				<DefaultRoleField
					roles={roles}
					defaultRoleId={defaultRoleId}
					valueState={combineStates(valueState, listState)}
					onSelect={setDefaultRole}
					error={defaultRoleError}
				/>

				{/* Both act on a list that is not on screen — Reset especially, which
				    would overwrite roles the user cannot see. The scroll region above
				    already says why they are gone, so this is not a control dimmed
				    without a reason. */}
				{listState === "known" && (
					<>
						<CreateRoleButton />
						<button
							type="button"
							onClick={() => setShowReset(true)}
							// No icon, and that absence is the step down from Add Role
							// above it. Muted rather than error-coloured: `text-th-error`
							// fails AA 4.5 in the five light themes (docs/project-ui.md §3
							// measures it), so red would say nothing in half of them, and
							// the confirm dialog is what carries the weight of a
							// destructive action.
							className="mt-1 flex min-h-[44px] w-full items-center rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
						>
							Reset to defaults
						</button>
					</>
				)}

				{/* Outside the gate above: a reset in flight when the socket drops
				    takes the list back to loading, and the button that raised this
				    with it — leaving the failure with nowhere to be read. */}
				{resetError && (
					<p className="px-3 py-1 text-xs text-th-error" role="alert">
						{resetError}
					</p>
				)}
			</div>

			{showReset && (
				<ConfirmDialog
					title="Reset agent roles"
					message="Reset all roles to defaults? Your customizations will be lost."
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
 * The only place the default role is written out as words, and the only way to
 * reach "None" — a star can clear the default, but no row then says that there
 * is none.
 *
 * A native `<select>` because that is already what this project draws a role
 * choice with, in both of the other two places it asks for one.
 */
function DefaultRoleField({
	roles,
	defaultRoleId,
	valueState,
	onSelect,
	error,
}: {
	roles: AgentRole[];
	defaultRoleId: string;
	valueState: ValueState;
	onSelect: (roleId: string) => void;
	error: string | null;
}) {
	const fieldId = useId();

	// A stored id with no role behind it is a transient the list will settle:
	// offering it as a row of its own keeps the field from claiming, even for a
	// frame, that Settings holds something it does not.
	const isDangling =
		defaultRoleId !== "" && !roles.some((r) => r.id === defaultRoleId);

	// What `CreateWorkSheet` will actually do, asked rather than restated — the
	// sentence below is a description of that form's behaviour, so it has to
	// come from the same rule the form preselects with.
	//
	// With no roles at all it says nothing: that form does not ask which role to
	// use there, it refuses and sends the user back here, and the empty list
	// above has already said so in the place the user is looking.
	const initialRoleId = resolveInitialRole(roles, defaultRoleId);
	const sentence =
		roles.length === 0
			? null
			: initialRoleId && initialRoleId === defaultRoleId
				? "New stories and tasks start with this role."
				: initialRoleId
					? `New stories and tasks use ${roles.find((r) => r.id === initialRoleId)?.name}, the only role.`
					: "New stories and tasks ask which role to use.";

	return (
		<div className="space-y-1.5 px-1 pb-1">
			<label htmlFor={fieldId} className="block text-sm text-th-text-primary">
				Default role
			</label>
			{valueState === "known" ? (
				<>
					<select
						id={fieldId}
						value={defaultRoleId}
						onChange={(e) => onSelect(e.target.value)}
						className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
					>
						<option value="">None</option>
						{isDangling && <option value={defaultRoleId}>Unknown role</option>}
						{roles.map((role) => (
							<option key={role.id} value={role.id}>
								{role.name}
							</option>
						))}
					</select>
					{sentence && <p className="text-xs text-th-text-muted">{sentence}</p>}
				</>
			) : (
				// Never "None" first: that says there is no default role, and the
				// user may well have one.
				<Skeleton
					className="h-11 w-full rounded-lg"
					animated={valueState === "pending"}
					label={waitingLabel("Default role", valueState)}
				/>
			)}
			{/* Every failure to change the default lands here, whichever control
			    caused it: this is the one place on screen that says in words what
			    the default currently is, and it never scrolls away. */}
			{error && (
				<p className="text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * One role as a card: line 1 is its name and whether it is the default, line 2
 * is what is true of it. The engine is on every row unconditionally, so every
 * card is exactly two lines tall and the list keeps one rhythm.
 *
 * Deliberately without `WorkRow`'s 2px left edge: that edge carries a work's
 * state as hue, and a role has no state — a permanently neutral channel is a
 * channel that says nothing.
 */
function RoleRow({
	role,
	workRefCount,
	isDefault,
	defaultState,
	onToggleDefault,
	onOpenDetail,
}: {
	role: AgentRole;
	/** How many work items name this role; 0 when none do. */
	workRefCount: number;
	isDefault: boolean;
	/** Whether `isDefault` is the stored answer; see the list's own comment. */
	defaultState: ValueState;
	onToggleDefault: (roleId: string) => void;
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

	// Fixed order, one appearance rule each, and the line clips from the right —
	// which puts the engine first and the count of other people's work last.
	// Nothing here is a placeholder: steps ride on the role record and the
	// reference counts arrive in the same reply the roles do, so a row on screen
	// already has both.
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
			node: <span>{count(role.steps.length, "step")}</span>,
		});
	}
	if (workRefCount > 0) {
		slots.push({
			key: "refs",
			node: <span>{count(workRefCount, "work item")}</span>,
		});
	}

	return (
		<div className="relative rounded-lg border border-th-border bg-th-bg-secondary px-2 hover:bg-th-bg-tertiary">
			<div className="flex min-h-[44px] items-center gap-2">
				{/* The page's `h1` is the only heading above this and there are no
				    group headings between, so the rows are its children. */}
				<h2 className="min-w-0 flex-1 text-sm font-normal">
					{/* The whole card is the tap target — the overlay reaches the
					    padding and line 2, growing with the card — while staying one
					    button a keyboard can reach; the star lifts itself above it.
					    The height is stated as well as covered: the overlay is the
					    `::after` box and not this one, so it is the `min-h` that
					    answers to the floors in docs/responsive-ui.md. */}
					<button
						type="button"
						onClick={() => onOpenDetail(role.id)}
						className="flex min-h-[44px] w-full items-center text-left text-sm text-th-text-primary after:absolute after:inset-0 after:content-[''] hover:text-th-accent"
						aria-label={`${role.name} — ${engine.text}`}
					>
						<span className="truncate">{role.name}</span>
					</button>
				</h2>
				{/* At the end of the line, where this project's row controls live; a
				    leading position in that idiom belongs to decorative glyphs. It
				    also makes DOM order the tab order: name, then star. */}
				<div className="relative z-10 shrink-0">
					<button
						type="button"
						onClick={() => onToggleDefault(role.id)}
						disabled={defaultState !== "known"}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center disabled:pointer-events-none disabled:opacity-50"
						// Named with the role, waiting or not: a column of
						// identically-worded controls is a column a screen reader cannot
						// tell apart, and there are as many of these as there are rows
						// while the snapshot is still out.
						aria-label={
							defaultState !== "known"
								? waitingLabel(`Default role for "${role.name}"`, defaultState)
								: isDefault
									? `Unset "${role.name}" as the default role`
									: `Set "${role.name}" as the default role`
						}
						// No `aria-pressed` while waiting: `false` is as much a claim
						// about the default role as `true` is.
						aria-pressed={defaultState === "known" ? isDefault : undefined}
						aria-busy={defaultState === "pending"}
					>
						{defaultState === "known" ? (
							<Star
								className={`size-4 ${isDefault ? "fill-th-accent text-th-accent" : "text-th-text-muted"}`}
							/>
						) : (
							<Skeleton
								className="size-4 rounded-full"
								animated={defaultState === "pending"}
							/>
						)}
					</button>
				</div>
			</div>

			{/* No negative margins: every slot here is plain text with no focus ring
			    to leave room for. */}
			<div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap pb-1 text-xs text-th-text-muted">
				{slots.map((slot, i) => (
					// The separator belongs to the slot that follows it, so a slot that
					// is absent takes its separator with it.
					<span key={slot.key} className="flex shrink-0 items-center gap-1.5">
						{i > 0 && <span aria-hidden="true">&middot;</span>}
						{slot.node}
					</span>
				))}
			</div>
		</div>
	);
}

function CreateRoleButton() {
	const [isCreating, setIsCreating] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const createAgentRole = useWSStore((s) => s.actions.createAgentRole);

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const trimmed = name.trim();
			if (!trimmed || isSubmitting) return;

			setError(null);
			setIsSubmitting(true);
			try {
				await createAgentRole({ name: trimmed, role_prompt: "" });
				setName("");
				setIsCreating(false);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to create role");
			} finally {
				setIsSubmitting(false);
			}
		},
		[name, createAgentRole, isSubmitting],
	);

	if (!isCreating) {
		return (
			<button
				type="button"
				onClick={() => setIsCreating(true)}
				className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary hover:text-th-text-primary"
			>
				<Plus className="size-4" />
				Add Role
			</button>
		);
	}

	return (
		<div className="rounded-lg bg-th-bg-secondary p-3">
			<form onSubmit={handleSubmit} className="space-y-2">
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Role name"
					className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
					// biome-ignore lint/a11y/noAutofocus: inline creation form
					autoFocus
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setIsCreating(false);
							setName("");
							setError(null);
						}
					}}
				/>
				<div className="flex gap-2">
					<button
						type="submit"
						disabled={!name.trim() || isSubmitting}
						className="min-h-[44px] flex-1 rounded-lg bg-th-accent px-3 text-sm font-medium text-th-accent-text disabled:opacity-50"
					>
						{isSubmitting ? "Adding..." : "Add"}
					</button>
					<button
						type="button"
						onClick={() => {
							setIsCreating(false);
							setName("");
							setError(null);
						}}
						className="min-h-[44px] rounded-lg px-3 text-sm text-th-text-muted hover:bg-th-bg-tertiary"
					>
						Cancel
					</button>
				</div>
			</form>
			{error && (
				<p className="mt-2 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
