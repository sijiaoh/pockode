import { useCallback, useEffect, useRef, useState } from "react";

interface UseInlineEditOptions {
	initialValue: string;
	onSave: (trimmedValue: string) => Promise<void>;
	/** When false (default), saving an empty string cancels instead. */
	allowEmpty?: boolean;
}

export function useInlineEdit<E extends HTMLElement>({
	initialValue,
	onSave,
	allowEmpty = false,
}: UseInlineEditOptions) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(initialValue);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<E>(null);

	useEffect(() => {
		if (!editing) setValue(initialValue);
	}, [initialValue, editing]);

	useEffect(() => {
		if (editing) ref.current?.focus();
	}, [editing]);

	const save = useCallback(async () => {
		const trimmed = value.trim();
		if (!allowEmpty && !trimmed) {
			setEditing(false);
			return;
		}
		if (trimmed === initialValue.trim()) {
			setEditing(false);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			await onSave(trimmed);
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [value, initialValue, allowEmpty, onSave]);

	const cancel = useCallback(() => {
		setValue(initialValue);
		setEditing(false);
		setError(null);
	}, [initialValue]);

	return {
		editing,
		setEditing,
		value,
		setValue,
		saving,
		error,
		ref,
		save,
		cancel,
	};
}
