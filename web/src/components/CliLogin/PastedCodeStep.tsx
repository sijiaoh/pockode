import { useEffect, useId, useRef } from "react";
import type { CliAccountKind, CliLogin } from "../../types/cliAuth";
import { inputClass } from "../ui/inputClass";
import { ExpiryLine, SignInLink, Step, textButtonClass } from "./loginParts";

interface Props {
	login: CliLogin;
	code: string;
	onCodeChange: (code: string) => void;
	/** The code is out for verification: the field is read-only. */
	verifying: boolean;
	/** Why the last submit was refused, if it was. */
	submitError: string | null;
	onSwitchAccountKind: (kind: CliAccountKind) => void;
}

const WRONG_CODE =
	"That code wasn't accepted. Check you pasted all of it, or open the sign-in page again for a new one.";

/**
 * Claude's pasted code: open the page, sign in, paste the code it shows. The
 * field's value is the sheet's alone — never stored, never a draft.
 */
export default function PastedCodeStep({
	login,
	code,
	onCodeChange,
	verifying,
	submitError,
	onSwitchAccountKind,
}: Props) {
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const errorId = useId();
	const malformed = login.code_malformed && login.phase === "waiting";

	// A rejected paste comes back selected, so the next paste replaces it.
	useEffect(() => {
		if (!malformed) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [malformed]);

	const isConsole = login.account_kind === "console";
	const error = submitError ?? (malformed ? WRONG_CODE : null);

	return (
		<div className="space-y-5">
			<Step
				number={1}
				title={
					isConsole
						? "Sign in with your Anthropic Console account"
						: "Sign in with your Claude account"
				}
			>
				{login.url && <SignInLink url={login.url} />}
				<button
					type="button"
					onClick={() =>
						onSwitchAccountKind(isConsole ? "claude_ai" : "console")
					}
					disabled={verifying}
					className={`${textButtonClass} -ml-2 disabled:opacity-50`}
				>
					{isConsole
						? "Use a Claude subscription instead"
						: "Use an Anthropic Console account instead"}
				</button>
			</Step>

			<Step number={2} title="Paste the code shown after you sign in">
				<div className="space-y-1.5">
					<label htmlFor={inputId} className="sr-only">
						Sign-in code
					</label>
					<input
						ref={inputRef}
						id={inputId}
						type="text"
						value={code}
						onChange={(e) => onCodeChange(e.target.value)}
						readOnly={verifying}
						// Plain text, not a password: the user has to see that what they
						// pasted is the code and not the link they copied earlier.
						autoComplete="off"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? errorId : undefined}
						className={`w-full rounded-lg bg-th-bg-primary px-3 py-2.5 font-mono text-th-text-primary ${inputClass}`}
					/>
					{error && (
						<p id={errorId} className="text-xs text-th-error" role="alert">
							{error}
						</p>
					)}
					<ExpiryLine expiresAt={login.expires_at} />
				</div>
			</Step>
		</div>
	);
}
