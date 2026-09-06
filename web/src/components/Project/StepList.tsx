import { Circle, CircleCheck, CircleDot } from "lucide-react";
import type { WorkStatus } from "../../types/work";

interface StepItemProps {
	step: string;
	index: number;
	currentStep: number;
	workStatus: WorkStatus;
}

function StepItem({ step, index, currentStep, workStatus }: StepItemProps) {
	const isClosed = workStatus === "closed";
	const isCompleted = isClosed || index < currentStep;
	// Show as current only for active states (not open or closed)
	const isActiveState =
		workStatus === "in_progress" ||
		workStatus === "waiting" ||
		workStatus === "needs_input" ||
		workStatus === "stopped";
	const isCurrent = isActiveState && index === currentStep;

	return (
		<li
			className={`flex items-start gap-3 rounded-lg px-3 py-2 transition-all duration-300 ${
				isCurrent ? "border-l-2 border-th-accent bg-th-accent/10" : ""
			}`}
		>
			<span
				className={`mt-0.5 shrink-0 transition-colors duration-300 ${
					isCompleted
						? "text-th-success"
						: isCurrent
							? "text-th-accent"
							: "text-th-text-muted"
				}`}
			>
				{isCompleted ? (
					<CircleCheck className="size-4" />
				) : isCurrent ? (
					<CircleDot className="size-4" />
				) : (
					<Circle className="size-4" />
				)}
			</span>
			<span
				className={`text-sm ${
					isCompleted
						? "text-th-text-muted"
						: isCurrent
							? "font-medium text-th-text-primary"
							: "text-th-text-muted"
				}`}
			>
				{step}
			</span>
		</li>
	);
}

interface Props {
	steps: string[];
	/** 0-based index of the step the work sits on. */
	currentStep: number;
	workStatus: WorkStatus;
	/** Surface styling, which differs between the detail page and the chat card. */
	className?: string;
}

/** The steps of a work role, marked up against the work's position in them. */
function StepList({ steps, currentStep, workStatus, className }: Props) {
	return (
		<ol className={`space-y-1 ${className ?? ""}`}>
			{steps.map((step, index) => (
				<StepItem
					// biome-ignore lint/suspicious/noArrayIndexKey: steps are strings without unique IDs, index is stable within the array
					key={index}
					step={step}
					index={index}
					currentStep={currentStep}
					workStatus={workStatus}
				/>
			))}
		</ol>
	);
}

export default StepList;
