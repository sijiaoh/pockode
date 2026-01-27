import { useMutation } from "@tanstack/react-query";
import { useSettingsStore } from "../../../lib/settingsStore";
import { useWSStore } from "../../../lib/wsStore";
import type { Settings } from "../../../types/settings";
import SettingsSection from "../SettingsSection";

export function SandboxSection({ id }: { id: string }) {
	const status = useWSStore((s) => s.status);
	const { updateSettings } = useWSStore((s) => s.actions);
	const settings = useSettingsStore((s) => s.settings);

	const mutation = useMutation({
		mutationFn: (newSettings: Settings) => updateSettings(newSettings),
	});

	const isEnabled = settings?.sandbox ?? false;

	const handleToggle = () => {
		if (settings) {
			mutation.mutate({ ...settings, sandbox: !isEnabled });
		}
	};

	if (status !== "connected" || settings === null) {
		return (
			<SettingsSection id={id} title="Sandbox">
				<div className="flex h-11 items-center justify-center text-sm text-th-text-muted">
					{status !== "connected" ? "Not connected" : "Loading..."}
				</div>
			</SettingsSection>
		);
	}

	return (
		<SettingsSection id={id} title="Sandbox">
			<button
				type="button"
				role="switch"
				aria-checked={isEnabled}
				onClick={handleToggle}
				disabled={mutation.isPending}
				className="flex w-full items-center justify-between rounded-lg border border-th-border bg-th-bg-primary px-3 py-3 transition-colors hover:bg-th-bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:opacity-50"
			>
				<div className="text-left">
					<div className="text-sm font-medium text-th-text-primary">
						Enable Docker Sandbox
					</div>
					<div className="text-xs text-th-text-muted">
						Run Claude CLI in an isolated Docker container
					</div>
				</div>
				<div
					className={`relative h-6 w-11 rounded-full transition-colors ${
						isEnabled ? "bg-th-accent" : "bg-th-bg-tertiary"
					}`}
				>
					<div
						className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
							isEnabled ? "translate-x-5" : "translate-x-0.5"
						}`}
					/>
				</div>
			</button>
			<p className="mt-3 text-xs text-th-text-secondary">
				<span className="text-th-warning">Authentication required</span>
				<br />
				Run{" "}
				<code className="rounded bg-th-bg-tertiary px-1 py-0.5">
					docker sandbox run --credentials host claude
				</code>{" "}
				in your project directory.
				<br />
				For worktrees:{" "}
				<code className="rounded bg-th-bg-tertiary px-1 py-0.5">
					../{"{project_name}"}-worktrees/{"{worktree_name}"}
				</code>
			</p>
		</SettingsSection>
	);
}
