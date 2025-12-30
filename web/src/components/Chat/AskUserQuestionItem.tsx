import { useState } from "react";
import type {
	AskUserQuestionRequest,
	QuestionStatus,
} from "../../types/message";
import { ScrollableContent } from "../ui";

interface Props {
	request: AskUserQuestionRequest;
	status: QuestionStatus;
	savedAnswers?: Record<string, string>;
	onRespond?: (
		requestId: string,
		answers: Record<string, string> | null,
	) => void;
}

function AskUserQuestionItem({
	request,
	status,
	savedAnswers,
	onRespond,
}: Props) {
	const isPending = status === "pending";
	const [expanded, setExpanded] = useState(isPending);

	// State for pending questions
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>(
		{},
	);
	const [otherText, setOtherText] = useState<Record<string, string>>({});

	const statusConfig = {
		pending: { icon: "?", color: "text-th-warning" },
		answered: { icon: "✓", color: "text-th-success" },
		cancelled: { icon: "✗", color: "text-th-error" },
	};

	const { icon, color } = statusConfig[status];

	// Get first question's header as summary
	const headerSummary =
		request.questions.length > 0 ? request.questions[0].header : "Question";

	const handleOptionSelect = (
		questionText: string,
		label: string,
		multiSelect: boolean,
	) => {
		if (multiSelect) {
			setAnswers((prev) => {
				const current = prev[questionText] || "";
				const labels = current ? current.split(", ") : [];
				const index = labels.indexOf(label);
				if (index >= 0) {
					labels.splice(index, 1);
				} else {
					labels.push(label);
				}
				return { ...prev, [questionText]: labels.join(", ") };
			});
		} else {
			setOtherSelected((prev) => ({ ...prev, [questionText]: false }));
			setAnswers((prev) => ({ ...prev, [questionText]: label }));
		}
	};

	const handleOtherSelect = (questionText: string, multiSelect: boolean) => {
		if (multiSelect) {
			setOtherSelected((prev) => ({
				...prev,
				[questionText]: !prev[questionText],
			}));
		} else {
			setOtherSelected((prev) => ({ ...prev, [questionText]: true }));
			setAnswers((prev) => ({ ...prev, [questionText]: "" }));
		}
	};

	const handleOtherTextChange = (questionText: string, text: string) => {
		setOtherText((prev) => ({ ...prev, [questionText]: text }));
	};

	const handleSubmit = () => {
		const finalAnswers: Record<string, string> = {};
		for (const q of request.questions) {
			if (q.multiSelect) {
				const parts: string[] = [];
				if (answers[q.question]) {
					parts.push(answers[q.question]);
				}
				if (otherSelected[q.question] && otherText[q.question]?.trim()) {
					parts.push(`Other: ${otherText[q.question]}`);
				}
				finalAnswers[q.question] = parts.join(", ");
			} else {
				if (otherSelected[q.question]) {
					finalAnswers[q.question] = `Other: ${otherText[q.question] || ""}`;
				} else {
					finalAnswers[q.question] = answers[q.question] || "";
				}
			}
		}
		onRespond?.(request.requestId, finalAnswers);
	};

	const isOptionSelected = (
		questionText: string,
		label: string,
		multiSelect: boolean,
	): boolean => {
		if (!multiSelect && otherSelected[questionText]) return false;
		const answer = answers[questionText] || "";
		if (multiSelect) {
			const labels = answer.split(", ");
			return labels.includes(label);
		}
		return answer === label;
	};

	const canSubmit = request.questions.every((q) => {
		if (q.multiSelect) {
			const hasRegularOption = (answers[q.question] || "").length > 0;
			const hasOtherWithText =
				otherSelected[q.question] &&
				(otherText[q.question] || "").trim().length > 0;
			return hasRegularOption || hasOtherWithText;
		}
		if (otherSelected[q.question]) {
			return (otherText[q.question] || "").trim().length > 0;
		}
		return (answers[q.question] || "").length > 0;
	});

	return (
		<div
			className={`rounded text-xs ${isPending ? "border border-th-warning bg-th-warning/10" : "bg-th-bg-secondary"}`}
		>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<span className={`w-4 shrink-0 text-center ${color}`}>{icon}</span>
				<span className="shrink-0 text-th-accent">Question</span>
				<span className="rounded bg-th-accent/20 px-1.5 py-0.5 text-th-accent">
					{headerSummary}
				</span>
				<span
					className={`ml-auto w-2.5 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				>
					▶
				</span>
			</button>

			{expanded && (
				<ScrollableContent className="max-h-80 overflow-auto border-t border-th-border p-2">
					{isPending ? (
						// Pending: show interactive form
						<div className="space-y-4">
							{request.questions.map((q) => (
								<div key={q.question} className="space-y-2">
									<div>
										<span className="inline-block rounded bg-th-accent/20 px-1.5 py-0.5 text-xs text-th-accent">
											{q.header}
										</span>
										<p className="mt-1 text-sm text-th-text-primary">
											{q.question}
										</p>
									</div>

									<div className="space-y-1.5">
										{q.options.map((opt) => (
											<label
												key={opt.label}
												className={`flex cursor-pointer items-start gap-2 rounded border p-2 transition-colors ${
													isOptionSelected(q.question, opt.label, q.multiSelect)
														? "border-th-accent bg-th-accent/10"
														: "border-th-border hover:border-th-accent/50"
												}`}
											>
												<input
													type={q.multiSelect ? "checkbox" : "radio"}
													name={q.question}
													checked={isOptionSelected(
														q.question,
														opt.label,
														q.multiSelect,
													)}
													onChange={() =>
														handleOptionSelect(
															q.question,
															opt.label,
															q.multiSelect,
														)
													}
													className="mt-0.5 accent-th-accent"
												/>
												<div className="flex-1">
													<div className="text-sm text-th-text-primary">
														{opt.label}
													</div>
													<div className="text-xs text-th-text-muted">
														{opt.description}
													</div>
												</div>
											</label>
										))}

										{/* Other option */}
										<label
											className={`flex cursor-pointer items-start gap-2 rounded border p-2 transition-colors ${
												otherSelected[q.question]
													? "border-th-accent bg-th-accent/10"
													: "border-th-border hover:border-th-accent/50"
											}`}
										>
											<input
												type={q.multiSelect ? "checkbox" : "radio"}
												name={q.question}
												checked={otherSelected[q.question] || false}
												onChange={() =>
													handleOtherSelect(q.question, q.multiSelect)
												}
												className="mt-0.5 accent-th-accent"
											/>
											<div className="flex-1">
												<div className="text-sm text-th-text-primary">
													Other
												</div>
												{otherSelected[q.question] && (
													<input
														type="text"
														value={otherText[q.question] || ""}
														onChange={(e) =>
															handleOtherTextChange(q.question, e.target.value)
														}
														placeholder="Enter your answer..."
														className="mt-1 w-full rounded border border-th-border bg-th-bg-primary px-2 py-1 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
													/>
												)}
											</div>
										</label>
									</div>
								</div>
							))}
						</div>
					) : (
						// Answered/Cancelled: show saved answers
						<div className="space-y-2">
							{request.questions.map((q) => (
								<div key={q.question}>
									<span className="text-th-text-muted">{q.header}:</span>{" "}
									<span className="text-th-text-primary">
										{savedAnswers?.[q.question] ||
											(status === "cancelled" ? "(cancelled)" : "(no answer)")}
									</span>
								</div>
							))}
						</div>
					)}
				</ScrollableContent>
			)}

			{isPending && onRespond && (
				<div className="flex justify-end gap-2 border-t border-th-border p-2">
					<button
						type="button"
						onClick={() => onRespond(request.requestId, null)}
						className="rounded bg-th-bg-secondary px-2 py-1 text-th-text-muted hover:bg-th-overlay-hover"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={!canSubmit}
						className="rounded bg-th-accent px-2 py-1 text-th-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Submit
					</button>
				</div>
			)}
		</div>
	);
}

export default AskUserQuestionItem;
