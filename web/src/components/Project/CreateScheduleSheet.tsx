import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { useDeviceTimeZone } from "../../hooks/useDeviceTimeZone";
import { useCurrentWorktree } from "../../hooks/useRouteState";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { resolveInitialJobRole } from "../../lib/initialRole";
import { roleAcceptsWorkType } from "../../lib/roleWorkType";
import { DEFAULT_CRON } from "../../lib/schedulePeriod";
import { useScheduleStore } from "../../lib/scheduleStore";
import { useWSStore } from "../../lib/wsStore";
import { Sheet } from "../ui";
import { inputClass } from "../ui/inputClass";
import NoEligibleRoleSheet from "./NoEligibleRoleSheet";
import PeriodField from "./PeriodField";
import RoleSelect from "./RoleSelect";

interface Props {
	onClose: () => void;
	/**
	 * The schedule that now exists. The caller navigates to it: `AppShell` owns
	 * every navigation (docs/project-ui.md §4).
	 */
	onCreated: (scheduleId: string) => void;
}

const TITLE = "New Schedule";

/**
 * The four fields the server requires, and no others (docs/schedule-ui.md §5).
 * Unlike a story, a schedule runs without anyone pressing Start, so it cannot
 * be made half-written: the prompt is asked here, not left to the detail page.
 *
 * The worktree is the one the user is in, said rather than asked; enabled is
 * left to the server's default. Both are one tap away on the page this lands on.
 */
export default function CreateScheduleSheet({ onClose, onCreated }: Props) {
	const titleFieldId = useId();
	const promptFieldId = useId();
	const roleFieldId = useId();
	const worktree = useCurrentWorktree();
	const [title, setTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [agentRoleId, setAgentRoleId] = useState("");
	// The field reports nothing until it is touched, so the cron it opens on is
	// written down here rather than read from it.
	const [cron, setCron] = useState<string | null>(DEFAULT_CRON);
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const createSchedule = useWSStore((s) => s.actions.createSchedule);
	const addCreatedSchedule = useScheduleStore((s) => s.addCreatedSchedule);
	// Not shown: a schedule made here is in this device's zone, so the period
	// typed means what it says on the user's clock (docs/schedule-ui.md §5).
	const deviceZone = useDeviceTimeZone();
	const roles = useAgentRoleStore((s) => s.roles);

	const selectedRole = roles.find((r) => r.id === agentRoleId);
	const selectedRoleFits =
		selectedRole !== undefined && roleAcceptsWorkType(selectedRole, "job");
	const hasEligibleRole = roles.some((r) => roleAcceptsWorkType(r, "job"));
	// A reconnect empties the role store while it reloads. Once the form has
	// been shown it stays through that: swapping to the no-role sheet would
	// remount `PeriodField`, which reads only its `initial`, so it would show
	// the default period while the cron held here is still the user's — and a
	// create in flight would lose its undismissable sheet.
	const rolesLoading = useAgentRoleStore((s) => s.isLoading);
	const [formShown, setFormShown] = useState(hasEligibleRole);
	if (hasEligibleRole && !formShown) setFormShown(true);

	// CreateStorySheet's rule, for jobs: preselect once the roles arrive, never
	// over a pick, and drop a pick that stopped taking jobs while open.
	useEffect(() => {
		if (selectedRole && !selectedRoleFits) {
			setAgentRoleId("");
			return;
		}
		if (!agentRoleId) {
			const initial = resolveInitialJobRole(roles);
			if (initial) setAgentRoleId(initial);
		}
	}, [roles, agentRoleId, selectedRole, selectedRoleFits]);

	const canSubmit =
		title.trim() !== "" &&
		prompt.trim() !== "" &&
		selectedRoleFits &&
		cron !== null &&
		!isSubmitting;

	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!canSubmit || cron === null) return;

			setError(null);
			setIsSubmitting(true);
			try {
				const created = await createSchedule({
					title: title.trim(),
					prompt: prompt.trim(),
					agent_role_id: agentRoleId,
					cron,
					time_zone: deviceZone,
					...(worktree ? { worktree } : {}),
				});
				// The detail page this lands on reads a loaded store without the id
				// as deleted, and the list notification may still be on its way.
				addCreatedSchedule(created);
				// The busy flag stays set: the caller closes this sheet, and until
				// it does a second submit would make a second schedule.
				onCreated(created.id);
			} catch (err) {
				// Everything typed stays: the server's message (an invalid cron's
				// names the field) is printed as it came.
				setError(
					err instanceof Error ? err.message : "Failed to create schedule",
				);
				setIsSubmitting(false);
			}
		},
		[
			canSubmit,
			cron,
			createSchedule,
			title,
			prompt,
			agentRoleId,
			deviceZone,
			worktree,
			addCreatedSchedule,
			onCreated,
		],
	);

	if (!hasEligibleRole && !(formShown && rolesLoading)) {
		// `PeriodField` unmounts with the form and opens on the default when it
		// comes back, so the cron it reports from goes back there with it.
		if (cron !== DEFAULT_CRON) setCron(DEFAULT_CRON);
		return (
			<NoEligibleRoleSheet title={TITLE} workType="job" onClose={onClose} />
		);
	}

	return (
		<Sheet
			title={TITLE}
			onClose={onClose}
			dismissible={!isSubmitting}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						disabled={isSubmitting}
						className="min-h-[44px] flex-1 rounded-lg bg-th-bg-tertiary px-4 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!canSubmit}
						className="flex min-h-[44px] flex-1 items-center justify-center rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isSubmitting ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Create"
						)}
					</button>
				</>
			}
		>
			<div className="space-y-4 p-4">
				<div className="space-y-1.5">
					<label
						htmlFor={titleFieldId}
						className="text-sm text-th-text-primary"
					>
						Title
					</label>
					<input
						id={titleFieldId}
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Schedule title"
						disabled={isSubmitting}
						autoComplete="off"
						className={`min-h-[44px] w-full rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
					/>
				</div>

				<div className="space-y-1.5">
					<label
						htmlFor={promptFieldId}
						className="text-sm text-th-text-primary"
					>
						Prompt
					</label>
					<TextareaAutosize
						id={promptFieldId}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder="What each run's agent should do"
						disabled={isSubmitting}
						minRows={4}
						className={`w-full resize-none rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
					/>
				</div>

				<div className="space-y-1.5">
					<label htmlFor={roleFieldId} className="text-sm text-th-text-primary">
						Role
					</label>
					<RoleSelect
						id={roleFieldId}
						value={agentRoleId}
						onChange={setAgentRoleId}
						emptyLabel="Select role..."
						workType="job"
						disabled={isSubmitting}
					/>
				</div>

				{/* Held still like the other fields: an edit made mid-request would
				    otherwise not be what was sent. */}
				<fieldset disabled={isSubmitting} className="min-w-0">
					<PeriodField initial="" onChange={setCron} />
				</fieldset>

				<p className="text-xs text-th-text-muted">
					Runs in {worktree || "main"}
				</p>

				{error && (
					<p className="text-sm text-th-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}
