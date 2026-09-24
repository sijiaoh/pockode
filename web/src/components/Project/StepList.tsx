import { Circle, CircleCheck, CircleDot } from "lucide-react";
import type { WorkStatus } from "../../types/work";
import { MarkdownContent } from "../Chat/MarkdownContent";

interface StepItemProps {
	step: string;
	index: number;
	currentStep: number;
	workStatus: WorkStatus;
}

function StepItem({ step, index, currentStep, workStatus }: StepItemProps) {
	const isClosed = workStatus === "closed";
	const isCompleted = isClosed || index < currentStep;
	// A step's position does not change because a turn started, so this reads the
	// status and never the activity: highlighted for everything but the two
	// statuses that sit outside the agent lifecycle.
	const isCurrent = workStatus !== "open" && !isClosed && index === currentStep;

	return (
		<li
			className={`flex items-start gap-3 rounded-lg px-3 py-2 transition-all duration-300 ${
				isCurrent ? "border-l-2 border-th-accent bg-th-accent/10" : ""
			}`}
		>
			<span
				className={`mt-1 shrink-0 transition-colors duration-300 ${
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
			<div
				className={`min-w-0 flex-1 ${
					isCompleted
						? "text-th-text-muted"
						: isCurrent
							? "font-medium text-th-text-primary"
							: "text-th-text-muted"
				}`}
			>
				{/* Steps are authored as markdown — the default roles carry blank lines
				    and lists — and the agent role page already renders this same string
				    that way. The state colour stays on this element, so the prose inside
				    it inherits rather than paints its own (`prose-inherit-color`,
				    src/index.css). */}
				<MarkdownContent content={step} className="prose-inherit-color" />
			</div>
		</li>
	);
}

interface Props {
	steps: string[];
	/** 0-based index of the step the work sits on. */
	currentStep: number;
	workStatus: WorkStatus;
	/** Surface styling, left to the caller — today only the detail page's Steps section. */
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
