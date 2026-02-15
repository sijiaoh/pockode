import { Bot, BotOff } from "lucide-react";
import { useSettingsStore } from "../../lib/settingsStore";
import { useWSStore } from "../../lib/wsStore";

export default function AutorunToggle() {
	const updateSettings = useWSStore((s) => s.actions.updateSettings);
	const enabled = useSettingsStore((s) => s.settings?.autorun ?? false);

	const handleToggle = async () => {
		try {
			await updateSettings({ autorun: !enabled });
		} catch (err) {
			console.error("Failed to update autorun setting:", err);
		}
	};

	return (
		<button
			type="button"
			onClick={handleToggle}
			className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
				enabled
					? "bg-green-600 text-white hover:bg-green-700"
					: "bg-th-bg-tertiary text-th-text-muted hover:bg-th-border"
			}`}
			title={
				enabled
					? "Autorun: ON — Server processes tickets automatically"
					: "Autorun: OFF — Manual ticket processing"
			}
		>
			{enabled ? <Bot className="h-4 w-4" /> : <BotOff className="h-4 w-4" />}
			{enabled ? "Auto" : "Manual"}
		</button>
	);
}
