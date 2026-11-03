import { WrapText } from "lucide-react";
import { useCodeWrap } from "../../lib/diffSettingsStore";
import ToggleIconButton from "./ToggleIconButton";

/** The bar's switch for `useCodeWrap`, the same in every view it serves. */
function WrapToggle() {
	const { wrap, toggleWrap } = useCodeWrap();
	return (
		<ToggleIconButton
			icon={WrapText}
			pressed={wrap}
			onClick={toggleWrap}
			label={wrap ? "Don't wrap lines" : "Wrap lines"}
		/>
	);
}

export default WrapToggle;
