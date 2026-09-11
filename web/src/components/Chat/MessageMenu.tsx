import { GitBranch } from "lucide-react";
import type { Message } from "../../types/message";
import { messagePreview } from "../../utils/messagePreview";
import MenuRow, { menuRowClass } from "../common/MenuRow";
import { Sheet } from "../ui";

interface Props {
	message: Message;
	/**
	 * Why forking this message is unavailable, shown on a disabled row. Absent
	 * means it is available. An action that could have applied is never hidden —
	 * a control that is not there teaches the user nothing.
	 */
	forkBlockedReason?: string;
	onFork: () => void;
	onClose: () => void;
}

/**
 * Everything a chat message can do beyond the one thing tapping it does.
 *
 * A sheet rather than a popover, for the same reasons `Files/FileEntryMenu`
 * is one: the app has nothing to anchor a dropdown on, and a menu anchored to a
 * row of a scrolling transcript would mean positioning, flipping and scroll
 * tracking. `Sheet` moves no focus of its own, here or anywhere, so opening
 * this by keyboard leaves focus on the `…` behind it — a gap shared by every
 * sheet in the app, inherited here rather than patched in one menu.
 */
function MessageMenu({ message, forkBlockedReason, onFork, onClose }: Props) {
	const preview = messagePreview(message);

	return (
		<Sheet title={preview || "Message"} onClose={onClose}>
			<div className="py-1">
				{forkBlockedReason ? (
					<button
						type="button"
						disabled
						className={`${menuRowClass} cursor-not-allowed text-th-text-muted`}
					>
						<GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />
						<span className="min-w-0">
							Fork from here
							<span className="block text-xs">{forkBlockedReason}</span>
						</span>
					</button>
				) : (
					<MenuRow icon={GitBranch} label="Fork from here" onClick={onFork} />
				)}
			</div>
		</Sheet>
	);
}

export default MessageMenu;
