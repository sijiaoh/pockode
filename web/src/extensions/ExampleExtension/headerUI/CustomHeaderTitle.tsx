import type { TitleComponentProps } from "../../../lib/registries/headerUIRegistry";

// A span, not a heading: the host already wraps this in its `h1`, and in a chat
// inside the button that opens the session panel.
export default function CustomHeaderTitle({ title }: TitleComponentProps) {
	return <span className="truncate">{title ?? "Custom Title"}</span>;
}
