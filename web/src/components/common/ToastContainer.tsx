import { AlertCircle, CheckCircle, Info, X } from "lucide-react";
import { createPortal } from "react-dom";
import { type Toast, toast, useToastStore } from "../../lib/toastStore";

const iconMap = {
	error: AlertCircle,
	success: CheckCircle,
	info: Info,
} as const;

const styleMap = {
	error: "bg-red-600 text-white",
	success: "bg-green-600 text-white",
	info: "bg-th-bg-secondary text-th-text-primary border border-th-border",
} as const;

function ToastItem({ item }: { item: Toast }) {
	const Icon = iconMap[item.type];

	return (
		<div
			className={`flex items-center gap-2 rounded-lg px-4 py-3 shadow-lg ${styleMap[item.type]}`}
			role="alert"
		>
			<Icon className="h-5 w-5 shrink-0" />
			<span className="flex-1 text-sm">{item.message}</span>
			<button
				type="button"
				onClick={() => toast.dismiss(item.id)}
				className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
				aria-label="Dismiss"
			>
				<X className="h-4 w-4" />
			</button>
		</div>
	);
}

export default function ToastContainer() {
	const toasts = useToastStore((state) => state.toasts);

	if (toasts.length === 0) {
		return null;
	}

	return createPortal(
		<div
			className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4"
			aria-live="polite"
		>
			{toasts.map((t) => (
				<div key={t.id} className="pointer-events-auto w-full max-w-sm">
					<ToastItem item={t} />
				</div>
			))}
		</div>,
		document.body,
	);
}
