import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWSStore } from "../../../lib/wsStore";
import type { Settings } from "../../../types/settings";
import SettingsSection from "../SettingsSection";

export function SandboxSection({ id }: { id: string }) {
	const queryClient = useQueryClient();
	const status = useWSStore((s) => s.status);
	const { getSettings, updateSettings } = useWSStore((s) => s.actions);

	const {
		data: settings,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["settings"],
		queryFn: getSettings,
		enabled: status === "connected",
		retry: false,
	});

	const mutation = useMutation({
		mutationFn: (newSettings: Settings) => updateSettings(newSettings),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["settings"] });
		},
		onError: () => {
			// Refetch to restore UI to server state
			queryClient.invalidateQueries({ queryKey: ["settings"] });
		},
	});

	const isEnabled = settings?.sandbox ?? false;

	const handleToggle = () => {
		if (settings) {
			mutation.mutate({ ...settings, sandbox: !isEnabled });
		}
	};

	if (status !== "connected") {
		return (
			<SettingsSection id={id} title="Sandbox">
				<div className="flex h-11 items-center justify-center text-sm text-th-text-muted">
					Not connected
				</div>
			</SettingsSection>
		);
	}

	if (isLoading) {
		return (
			<SettingsSection id={id} title="Sandbox">
				<div className="flex h-11 items-center justify-center text-sm text-th-text-muted">
					Loading...
				</div>
			</SettingsSection>
		);
	}

	if (error) {
		return (
			<SettingsSection id={id} title="Sandbox">
				<div className="flex h-11 items-center justify-center text-sm text-red-500">
					Failed to load settings
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
			{isEnabled && (
				<p className="mt-3 text-xs text-th-text-muted">
					Requires{" "}
					<code className="rounded bg-th-bg-tertiary px-1 py-0.5">
						docker sandbox
					</code>{" "}
					command. Run{" "}
					<code className="rounded bg-th-bg-tertiary px-1 py-0.5">
						docker sandbox run claude
					</code>{" "}
					once to authenticate.
				</p>
			)}
		</SettingsSection>
	);
}
