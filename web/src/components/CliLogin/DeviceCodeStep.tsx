import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { CliLogin } from "../../types/cliAuth";
import { Spinner } from "../ui";
import { ExpiryLine, SignInLink, Step, textButtonClass } from "./loginParts";

/**
 * Codex's device code: the code first, because the page the link opens asks
 * for it and the user needs it in hand before leaving. Nothing is done in
 * Pockode after the browser; the server sees the CLI finish.
 */
export default function DeviceCodeStep({ login }: { login: CliLogin }) {
	const { state: copyState, copy } = useCopyToClipboard();
	const code = login.user_code ?? "";

	return (
		<div className="space-y-5">
			<Step number={1} title="Copy this code">
				<div className="flex items-center gap-2">
					<p className="min-w-0 flex-1 select-all break-all rounded-lg bg-th-bg-tertiary px-4 py-3 text-center font-mono text-2xl tracking-widest text-th-text-primary">
						{code}
					</p>
					<button
						type="button"
						onClick={() => copy(code)}
						className={textButtonClass}
						aria-label="Copy code"
					>
						Copy
					</button>
				</div>
				{/* Stays until the sheet moves on rather than flashing: the user reads
				    it after coming back from another app. */}
				{copyState === "copied" && (
					<p className="text-xs text-th-text-muted">Code copied</p>
				)}
				{copyState === "failed" && (
					<p className="text-xs text-th-error" role="alert">
						Copy the code above by hand.
					</p>
				)}
			</Step>

			<Step number={2} title="Enter it on the sign-in page">
				{login.url && (
					// Opening also copies the code, so one tap leaves the user in the
					// browser with it ready to paste. The link opens either way.
					<SignInLink url={login.url} onOpen={() => void copy(code)} />
				)}
				<div className="space-y-1">
					<p className="flex items-center gap-2 text-sm text-th-text-secondary">
						<Spinner srText={null} />
						Waiting for you to finish in the browser…
					</p>
					<ExpiryLine expiresAt={login.expires_at} />
				</div>
			</Step>
		</div>
	);
}
