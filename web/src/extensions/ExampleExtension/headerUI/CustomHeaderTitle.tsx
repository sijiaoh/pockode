import type { TitleComponentProps } from "../../../lib/registries/headerUIRegistry";

export default function CustomHeaderTitle({ title }: TitleComponentProps) {
	return (
		<h1 className="text-base font-bold text-th-text-primary sm:text-lg">
			{title ?? "Custom Title"}
		</h1>
	);
}
