import { Sheet, Spinner } from "@pockode/shared";
import { useEffect, useId, useRef, useState } from "react";
import { generateNodePassword } from "../lib/nodePassword";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON } from "./buttons";

interface StartNodeSheetProps {
	nodeName: string;
	/**
	 * `stopAndStart` is an older node's Restart: the cluster cannot ask it to
	 * restart, so it is stopped and started with the password typed here
	 * (docs/restart-ui.md, "Older nodes: stop and start, once"). The field and
	 * its rules are the same; only the words around them differ.
	 */
	variant?: "start" | "stopAndStart";
	/**
	 * Why the action attempted from this sheet failed — the card behind is
	 * hiding it: a start, or in `stopAndStart` the stop before it. Only this
	 * sheet's own failure: the card's error outlives whatever raised it, and a
	 * cleanup's would read here as a start that had already gone wrong.
	 */
	error?: string;
	password: string;
	/** What is in flight; a stop-and-start goes through both. */
	progress: "stopping" | "starting" | null;
	onPasswordChange: (password: string) => void;
	onConfirm: () => void;
	onCancel: () => void;
}

export function StartNodeSheet({
	nodeName,
	variant = "start",
	error,
	password,
	progress,
	onPasswordChange,
	onConfirm,
	onCancel,
}: StartNodeSheetProps) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);
	const loading = progress !== null;
	const stopAndStart = variant === "stopAndStart";

	// Not `autoFocus`: the sheet takes focus itself in an effect, which runs
	// after this subtree is mounted and would undo it.
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleGenerate = () => {
		onPasswordChange(generateNodePassword());
		setCopyState("idle");
		inputRef.current?.focus();
	};

	// A generated password exists nowhere else, so a copy that fails silently
	// hands the user a secret they can neither read (the field is masked) nor
	// retrieve.
	// `navigator.clipboard` is absent outside a secure context, which is exactly
	// where a self-hosted cluster is often reached, so this path is real.
	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(password);
			setCopyState("copied");
		} catch {
			setCopyState("failed");
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!password.trim() || loading) return;
		onConfirm();
	};

	return (
		<Sheet
			title={`${stopAndStart ? "Restart" : "Start"} ${nodeName}`}
			onClose={onCancel}
			dismissible={!loading}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onCancel}
						disabled={loading}
						className={`${NEUTRAL_BUTTON} flex-1`}
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={loading || !password.trim()}
						className={`${PRIMARY_BUTTON} flex-1`}
					>
						{loading && <Spinner size="h-4 w-4" />}
						{progress === "stopping"
							? "Stopping..."
							: progress === "starting"
								? "Starting..."
								: stopAndStart
									? "Stop and start"
									: "Start"}
					</button>
				</>
			}
		>
			<div className="flex flex-col gap-4 p-4">
				{/* A failed start keeps this sheet open, which puts the card — and the
				    reason — behind it. Repeated here rather than moved, because the
				    card is where the error belongs once this sheet is gone. Its own
				    `role="alert"`: the sheet is `aria-modal`, so a screen reader
				    treats the card's live region behind it as inert. */}
				{error && (
					<p
						role="alert"
						className="rounded-lg border border-th-error/30 bg-th-error/10 px-3 py-2 text-sm text-th-error"
					>
						{error}
					</p>
				)}
				{stopAndStart ? (
					<p className="text-sm text-th-text-secondary">
						This node was started by an older Pockode, which can't be restarted
						by the cluster. It is stopped and started again instead, which needs
						its password — this once: after that, Restart needs none. Any AI
						turn running in it is stopped — its session and history are kept.
					</p>
				) : (
					<p className="text-sm text-th-text-secondary">
						Used by the Pockode server started in this project. It is not the
						cluster password.
					</p>
				)}
				<div>
					<label
						htmlFor={inputId}
						className="mb-1 block text-sm text-th-text-secondary"
					>
						Node password
					</label>
					<input
						ref={inputRef}
						id={inputId}
						type="password"
						autoComplete="new-password"
						value={password}
						onChange={(e) => {
							onPasswordChange(e.target.value);
							setCopyState("idle");
						}}
						disabled={loading}
						className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 font-mono text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none disabled:opacity-50"
					/>
					<div className="mt-2 flex items-center gap-2">
						<button
							type="button"
							onClick={handleGenerate}
							disabled={loading}
							className={NEUTRAL_BUTTON}
						>
							Generate
						</button>
						<button
							type="button"
							onClick={handleCopy}
							disabled={loading || !password}
							className={NEUTRAL_BUTTON}
						>
							Copy
						</button>
						{copyState !== "idle" && (
							<output
								className={`text-xs ${
									copyState === "copied"
										? "text-th-text-muted"
										: "text-th-error"
								}`}
							>
								{copyState === "copied"
									? "Copied"
									: "Could not copy. Take it down from here:"}
							</output>
						)}
					</div>
					{/* Revealed only when the copy failed, and only because there is no
					    other way out: "select the field and copy it yourself" is not
					    advice a masked input can take — browsers block copying from a
					    password field — and this password is needed again to sign in to
					    the server it starts. Asking for it is what unmasks it. */}
					{copyState === "failed" && (
						<code className="mt-2 block break-all rounded-lg border border-th-border bg-th-bg-primary p-2 font-mono text-xs text-th-text-primary">
							{password}
						</code>
					)}
					{stopAndStart && (
						<p className="mt-2 text-xs text-th-text-muted">
							The password it runs with now. A new one works too, and signs out
							every device signed in to it.
						</p>
					)}
				</div>
			</div>
		</Sheet>
	);
}
