import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Container, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { useWSStore } from "../../../lib/wsStore";
import type { SandboxMode, Settings } from "../../../types/settings";
import SettingsSection from "../SettingsSection";

const SANDBOX_OPTIONS: {
	value: SandboxMode;
	label: string;
	description: string;
	icon: ReactNode;
}[] = [
	{
		value: "host",
		label: "Host",
		description: "Use local claude command directly",
		icon: <Monitor className="h-4 w-4" aria-hidden="true" />,
	},
	{
		value: "yolo_only",
		label: "YOLO Only",
		description: "Docker sandbox for YOLO mode only",
		icon: <Box className="h-4 w-4" aria-hidden="true" />,
	},
	{
		value: "always",
		label: "Always",
		description: "Always use Docker sandbox",
		icon: <Container className="h-4 w-4" aria-hidden="true" />,
	},
];

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

	const currentMode = settings?.sandbox ?? "host";

	const handleChange = (mode: SandboxMode) => {
		if (settings) {
			mutation.mutate({ ...settings, sandbox: mode });
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

	const showDockerNote = currentMode !== "host";

	return (
		<SettingsSection id={id} title="Sandbox">
			{/* biome-ignore lint/a11y/useSemanticElements: fieldset is for forms; this is an instant-apply toggle group */}
			<div
				role="group"
				aria-label="Sandbox mode"
				className="grid grid-cols-1 gap-2"
			>
				{SANDBOX_OPTIONS.map((option) => {
					const isSelected = currentMode === option.value;
					return (
						<button
							key={option.value}
							type="button"
							onClick={() => handleChange(option.value)}
							disabled={mutation.isPending}
							aria-pressed={isSelected}
							className={`flex min-h-12 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-[0.98] disabled:opacity-50 ${
								isSelected
									? "border-th-accent bg-th-bg-secondary ring-1 ring-th-accent"
									: "border-th-border bg-th-bg-primary hover:border-th-text-muted hover:bg-th-bg-secondary"
							}`}
						>
							<div
								className={`flex h-8 w-8 items-center justify-center rounded-md ${
									isSelected
										? "bg-th-accent text-white"
										: "bg-th-bg-tertiary text-th-text-muted"
								}`}
							>
								{option.icon}
							</div>
							<div className="flex-1">
								<div className="text-sm font-medium text-th-text-primary">
									{option.label}
								</div>
								<div className="text-xs text-th-text-muted">
									{option.description}
								</div>
							</div>
						</button>
					);
				})}
			</div>
			{showDockerNote && (
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
