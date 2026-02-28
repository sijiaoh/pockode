import type { AvatarProps } from "../../../lib/registries/chatUIRegistry";

export default function CustomUserAvatar({ className }: AvatarProps) {
	return (
		<div
			className={`flex items-center justify-center rounded-full bg-blue-500 text-white ${className ?? ""}`}
		>
			<span className="text-sm font-medium">U</span>
		</div>
	);
}
