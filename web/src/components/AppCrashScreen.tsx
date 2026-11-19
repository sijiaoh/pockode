import { CrashScreen } from "@pockode/shared";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { startPathOf } from "../lib/routes";

/**
 * The router's last line: a throw nothing nearer caught replaces the app
 * with this. The failed page is in the URL, so a reload throws again, and
 * Back may lead nowhere after one — "Go to project" is the way out that
 * always works. It is a full load, since the state the throw left behind is
 * not worth keeping, and the path is read off the URL rather than any store
 * for the same reason.
 */
export default function AppCrashScreen({ error }: ErrorComponentProps) {
	return (
		<CrashScreen
			error={error}
			title="This page couldn't be shown"
			actions={[
				{ label: "Go back", onClick: () => window.history.back() },
				{
					label: "Go to project",
					onClick: () =>
						window.location.replace(startPathOf(window.location.pathname)),
				},
			]}
		/>
	);
}
