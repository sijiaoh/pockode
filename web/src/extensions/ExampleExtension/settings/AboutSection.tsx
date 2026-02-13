import { ExternalLink } from "lucide-react";
import { APP_VERSION } from "../../../lib/version";

export default function AboutSection() {
	return (
		<div className="flex items-center justify-between text-sm text-th-text-muted">
			<span>Pockode {APP_VERSION}</span>
			<a
				href="https://github.com/sijiaoh/pockode"
				target="_blank"
				rel="noopener noreferrer"
				className="-m-2 inline-flex items-center gap-1 p-2 text-th-text-secondary transition-colors hover:text-th-accent focus:outline-none focus-visible:text-th-accent"
			>
				GitHub
				<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
			</a>
		</div>
	);
}
