import { type ReactNode, useId } from "react";

/**
 * One titled block of a `ResponsivePanel`, for read-only content.
 *
 * `ChoiceList`'s `Section` is the right look and the wrong element — it is a
 * `fieldset` with a `legend`, built for the pick-one-of lists it ships with. A
 * block of figures is not a group of form controls, so this borrows its
 * typography and stays an `h3` with a plain `div`.
 *
 * The rule above the second section on is written as `first:` rather than
 * passed in, so a panel composing these owns nothing but their order — adding a
 * section is one more line, and no section knows where it sits.
 */
function PanelSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	const titleId = useId();

	return (
		// Named, because an unnamed `section` is not exposed as a region at all —
		// which would leave a screen reader with the same unlabelled run of figures
		// the heading exists to prevent.
		<section
			aria-labelledby={titleId}
			className="mt-2 border-t border-th-border first:mt-0 first:border-t-0"
		>
			{/* The heading exists from the first section on: at and above the
			    expanded tier the panel is a dropdown with no visible title, so this
			    is the only label the content will ever have on a desktop. */}
			<h3
				id={titleId}
				className="px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-th-text-muted"
			>
				{title}
			</h3>
			{children}
		</section>
	);
}

export default PanelSection;
