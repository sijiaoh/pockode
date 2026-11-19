export interface CrashScreenAction {
	label: string;
	onClick: () => void;
}

export interface CrashScreenProps {
	error: unknown;
	title: string;
	/**
	 * The ways out, the last one drawn as primary. At least one has to work
	 * from a reload of the page that failed, with no address bar to type
	 * another into — an installed app has none — so it leaves for somewhere
	 * that is not what failed rather than retrying it.
	 */
	actions: [...CrashScreenAction[], CrashScreenAction];
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	return String(error);
}

const buttonClass =
	"min-h-11 rounded-lg px-4 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-offset-2";

/**
 * What an app draws when nothing closer to the failure caught it: the whole
 * page, since whatever would have been around it is gone too.
 */
export function CrashScreen({ error, title, actions }: CrashScreenProps) {
	return (
		<div
			role="alert"
			className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-th-bg-primary p-6 text-center"
		>
			<h1 className="text-lg font-medium text-th-text-primary">{title}</h1>
			<pre className="max-h-48 w-full max-w-md overflow-auto whitespace-pre-wrap break-words rounded-lg border border-th-border bg-th-bg-secondary p-3 text-left text-xs text-th-text-secondary">
				{messageOf(error)}
			</pre>
			<div className="flex flex-wrap justify-center gap-2">
				{actions.map((action, index) => (
					<button
						key={action.label}
						type="button"
						onClick={action.onClick}
						className={`${buttonClass} ${
							index === actions.length - 1
								? "bg-th-accent text-th-accent-text hover:bg-th-accent-hover"
								: "bg-th-bg-tertiary text-th-text-primary hover:bg-th-bg-secondary"
						}`}
					>
						{action.label}
					</button>
				))}
			</div>
		</div>
	);
}
