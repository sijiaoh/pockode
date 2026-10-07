import { AppWindow } from "lucide-react";
import { useState } from "react";
import { useWSStore } from "../../lib/wsStore";
import { headerIconButtonClass } from "../ui";
import PortPreviewSheet from "./PortPreviewSheet";

/**
 * Self-contained — it reads the relay address and owns its sheet — so a custom
 * `HeaderContent` can place it without new props. Renders nothing when the
 * relay is disabled: previews do not exist in that deployment, which is not
 * the same as being unavailable for now.
 */
function PortPreviewButton() {
	const remoteUrl = useWSStore((s) => s.remoteUrl);
	const [isOpen, setIsOpen] = useState(false);

	if (!remoteUrl) return null;

	return (
		<>
			<button
				type="button"
				onClick={() => setIsOpen(true)}
				className={headerIconButtonClass}
				aria-label="Preview a port"
			>
				<AppWindow className="size-5" aria-hidden="true" />
			</button>
			{isOpen && (
				<PortPreviewSheet
					remoteUrl={remoteUrl}
					onClose={() => setIsOpen(false)}
				/>
			)}
		</>
	);
}

export default PortPreviewButton;
