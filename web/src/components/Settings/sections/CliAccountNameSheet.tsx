import { useHasFinePointer } from "@pockode/shared";
import { useEffect, useId, useRef, useState } from "react";
import { getAgentLabel } from "../../../lib/agentType";
import { unavailableText } from "../../../lib/cliProfiles";
import type { AgentType } from "../../../types/settings";
import { errorMessage } from "../../../utils/errorMessage";
import {
	primaryButtonClass,
	secondaryButtonClass,
} from "../../CliLogin/loginParts";
import { Sheet, Spinner } from "../../ui";
import { inputClass } from "../../ui/inputClass";

type Props = {
	agent: AgentType;
	onClose: () => void;
} & (
	| {
			mode: "add" | "rename";
			/** The name being changed, for `rename`. */
			currentName?: string;
			/** Runs the change; a rejection is the server's refusal of the name. */
			onSubmit: (name: string) => Promise<void>;
	  }
	| {
			/** The machine cannot have accounts: the reason, and no field. */
			mode: "unavailable";
			reason: string | undefined;
	  }
);

/**
 * Names an account, for adding or renaming one
 * (docs/cli-profiles-ui.md#adding-an-account). The client checks nothing the
 * server checks: its refusal is shown under the field.
 */
export default function CliAccountNameSheet(props: Props) {
	const { agent, onClose } = props;
	const label = getAgentLabel(agent);

	if (props.mode === "unavailable") {
		return (
			<Sheet
				title={`Add a ${label} account`}
				onClose={onClose}
				footer={
					<button
						type="button"
						onClick={onClose}
						className={`${secondaryButtonClass} flex-1`}
					>
						Close
					</button>
				}
			>
				<p className="p-4 text-sm text-th-text-secondary">
					{unavailableText(props.reason)}
				</p>
			</Sheet>
		);
	}
	return <NameForm {...props} mode={props.mode} />;
}

function NameForm({
	agent,
	mode,
	currentName,
	onClose,
	onSubmit,
}: {
	agent: AgentType;
	mode: "add" | "rename";
	currentName?: string;
	onClose: () => void;
	onSubmit: (name: string) => Promise<void>;
}) {
	const adding = mode === "add";
	const [name, setName] = useState(adding ? "" : (currentName ?? ""));
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const errorId = useId();
	const hintId = useId();
	const finePointer = useHasFinePointer();

	// Once, on open. A thumb is not handed a keyboard it did not ask for.
	// biome-ignore lint/correctness/useExhaustiveDependencies: opening the sheet is the trigger
	useEffect(() => {
		if (!adding) inputRef.current?.select();
		else if (finePointer) inputRef.current?.focus();
	}, []);

	const trimmed = name.trim();
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!trimmed || submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			await onSubmit(trimmed);
		} catch (err) {
			setError(errorMessage(err));
			setSubmitting(false);
		}
	};

	// The field is enabled again by then: the refused name is kept, selected.
	useEffect(() => {
		if (error) inputRef.current?.select();
	}, [error]);

	const submitLabel = adding
		? submitting
			? "Adding…"
			: "Add"
		: submitting
			? "Saving…"
			: "Save";

	return (
		<Sheet
			title={
				adding ? `Add a ${getAgentLabel(agent)} account` : "Rename account"
			}
			onClose={onClose}
			dismissible={!submitting}
			onSubmit={submit}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						disabled={submitting}
						className={`${secondaryButtonClass} flex-1`}
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!trimmed || submitting}
						className={`${primaryButtonClass} flex-1`}
					>
						{submitting && <Spinner variant="current" srText={null} />}
						{submitLabel}
					</button>
				</>
			}
		>
			<div className="space-y-1.5 p-4">
				<label htmlFor={inputId} className="text-sm text-th-text-primary">
					Name
				</label>
				<input
					ref={inputRef}
					id={inputId}
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="e.g. Work"
					maxLength={64}
					disabled={submitting}
					autoComplete="off"
					aria-invalid={error !== null}
					aria-describedby={
						[error ? errorId : null, adding ? hintId : null]
							.filter(Boolean)
							.join(" ") || undefined
					}
					className={`w-full rounded-lg bg-th-bg-primary px-3 py-2.5 text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
				/>
				{error && (
					<p id={errorId} className="text-xs text-th-error" role="alert">
						{error}
					</p>
				)}
				{adding && (
					<p id={hintId} className="text-xs text-th-text-muted">
						You'll sign in to it next. It won't become the current account until
						you switch to it.
					</p>
				)}
			</div>
		</Sheet>
	);
}
