import type { AvatarProps } from "../../../lib/registries/chatUIRegistry";

export default function CustomAssistantAvatar({ className }: AvatarProps) {
	return (
		<div
			className={`flex items-center justify-center rounded-full bg-purple-500 text-white ${className ?? ""}`}
		>
			<span className="text-sm font-medium">AI</span>
		</div>
	);
}
