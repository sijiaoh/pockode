import { useState } from "react";

interface Props {
	onSubmit: (password: string) => void;
	/** Why the last attempt was turned away, if it was. */
	error?: string | null;
}

function PasswordInput({ onSubmit, error }: Props) {
	const [password, setPassword] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = password.trim();
		if (trimmed) {
			onSubmit(trimmed);
		}
	};

	return (
		<div className="flex h-dvh items-center justify-center bg-th-bg-primary">
			<form onSubmit={handleSubmit} className="w-full max-w-md p-6">
				<h1 className="mb-6 text-center text-2xl font-bold text-th-text-primary">
					Pockode
				</h1>
				<label
					htmlFor="password-input"
					className="mb-4 block text-center text-th-text-muted"
				>
					Enter your password to connect
				</label>
				<input
					id="password-input"
					type="password"
					autoComplete="current-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					placeholder="Password"
					className="mb-4 w-full rounded-lg border border-th-border bg-th-bg-secondary p-3 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
				/>
				{error && <p className="mb-4 text-sm text-th-error">{error}</p>}
				<button
					type="submit"
					disabled={!password.trim()}
					className="w-full rounded-lg bg-th-accent p-3 text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:bg-th-bg-tertiary disabled:text-th-text-muted"
				>
					Connect
				</button>
			</form>
		</div>
	);
}

export default PasswordInput;
