import type { ReactNode } from "react";

interface Props {
	id: string;
	title: string;
	children: ReactNode;
}

export default function SettingsSection({ id, title, children }: Props) {
	return (
		<section id={id} className="mb-6">
			<h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-th-text-muted">
				{title}
			</h2>
			{children}
		</section>
	);
}
