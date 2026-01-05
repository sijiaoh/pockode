import { useState } from "react";

interface Props {
	onSubmit: (token: string) => void;
}

function TokenInput({ onSubmit }: Props) {
	const [authToken, setAuthToken] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = authToken.trim();
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
					htmlFor="token-input"
					className="mb-4 block text-center text-th-text-muted"
				>
					Enter your authentication token to connect
				</label>
				<input
					id="token-input"
					type="password"
					value={authToken}
					onChange={(e) => setAuthToken(e.target.value)}
					placeholder="Token"
					className="mb-4 w-full rounded-lg border border-th-border bg-th-bg-secondary p-3 text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none"
				/>
				<button
					type="submit"
					disabled={!authToken.trim()}
					className="w-full rounded-lg bg-th-accent p-3 font-semibold text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:bg-th-bg-tertiary disabled:text-th-text-muted"
				>
					Connect
				</button>
			</form>
		</div>
	);
}

export default TokenInput;
