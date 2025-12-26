import { useEffect, useRef } from "react";
import type { PermissionRequest } from "../../types/message";

interface Props {
	request: PermissionRequest;
	onAllow: () => void;
	onAlwaysAllow: () => void;
	onDeny: () => void;
}

function PermissionDialog({ request, onAllow, onAlwaysAllow, onDeny }: Props) {
	const allowButtonRef = useRef<HTMLButtonElement>(null);

	// Focus trap and keyboard handling
	useEffect(() => {
		// Focus the Allow button when dialog opens
		allowButtonRef.current?.focus();

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onDeny();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onDeny]);

	const formatInput = (input: unknown): string => {
		if (typeof input === "string") return input;
		try {
			return JSON.stringify(input, null, 2);
		} catch {
			return String(input);
		}
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			role="dialog"
			aria-modal="true"
			aria-labelledby="permission-dialog-title"
		>
			<div className="mx-4 max-h-[80vh] w-full max-w-lg overflow-hidden rounded-lg bg-gray-800 shadow-xl">
				<div className="border-b border-gray-700 p-4">
					<h2
						id="permission-dialog-title"
						className="text-lg font-semibold text-white"
					>
						Tool Permission Request
					</h2>
					<p className="mt-1 text-sm text-gray-400">
						The AI wants to use a tool. Do you allow it?
					</p>
				</div>

				<div className="max-h-[50vh] overflow-y-auto p-4">
					<div className="mb-3">
						<span className="text-sm text-gray-400">Tool:</span>
						<span className="ml-2 font-mono text-blue-400">
							{request.toolName}
						</span>
					</div>

					<div>
						<span className="text-sm text-gray-400">Input:</span>
						<pre className="mt-2 overflow-x-auto rounded bg-gray-900 p-3 text-sm text-gray-300">
							{formatInput(request.toolInput)}
						</pre>
					</div>
				</div>

				<div className="flex justify-end gap-3 border-t border-gray-700 p-4">
					<button
						type="button"
						onClick={onDeny}
						className="rounded-lg bg-gray-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-500"
					>
						Deny
					</button>
					{request.permissionSuggestions &&
						request.permissionSuggestions.length > 0 && (
							<button
								type="button"
								onClick={onAlwaysAllow}
								className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500"
							>
								Always Allow
							</button>
						)}
					<button
						ref={allowButtonRef}
						type="button"
						onClick={onAllow}
						className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
					>
						Allow
					</button>
				</div>
			</div>
		</div>
	);
}

export default PermissionDialog;
