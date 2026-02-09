import { Info } from "lucide-react";
import SettingsSection from "../../../components/Settings/SettingsSection";

const VERSION = "0.1.0-dev";

export default function AboutSection({ id }: { id: string }) {
	return (
		<SettingsSection id={id} title="About">
			<div className="rounded-lg border border-th-border bg-th-bg-secondary p-4">
				<div className="flex items-center gap-3">
					<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-th-accent/10">
						<Info className="h-5 w-5 text-th-accent" aria-hidden="true" />
					</div>
					<div>
						<div className="font-medium text-th-text-primary">Pockode</div>
						<div className="text-sm text-th-text-muted">Version {VERSION}</div>
					</div>
				</div>
				<p className="mt-3 text-sm text-th-text-secondary">
					AI-first mobile programming platform.
				</p>
			</div>
		</SettingsSection>
	);
}
