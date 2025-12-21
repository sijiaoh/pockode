import { useState } from "react";

interface Props {
	onSubmit: (token: string) => void;
}

function TokenInput({ onSubmit }: Props) {
	const [token, setToken] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = token.trim();
		if (trimmed) {
			onSubmit(trimmed);
		}
	};

	return (
		<div className="flex h-screen items-center justify-center bg-gray-900">
			<form onSubmit={handleSubmit} className="w-full max-w-md p-6">
				<h1 className="mb-6 text-center text-2xl font-bold text-white">
					Pockode
				</h1>
				<label
					htmlFor="token-input"
					className="mb-4 block text-center text-gray-400"
				>
					Enter your authentication token to connect
				</label>
				<input
					id="token-input"
					type="password"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="Token"
					className="mb-4 w-full rounded-lg border border-gray-600 bg-gray-800 p-3 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
				/>
				<button
					type="submit"
					disabled={!token.trim()}
					className="w-full rounded-lg bg-blue-600 p-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-600"
				>
					Connect
				</button>
			</form>
		</div>
	);
}

export default TokenInput;
