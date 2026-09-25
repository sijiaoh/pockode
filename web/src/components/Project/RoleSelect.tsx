import type { ComponentProps } from "react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { inputClass } from "../ui/inputClass";

type Props = Omit<
	ComponentProps<"select">,
	"value" | "onChange" | "className" | "children"
> & {
	value: string;
	onChange: (roleId: string) => void;
	/** Offers `""` as a choice under this label; omit it to offer no empty choice. */
	emptyLabel?: string;
};

/**
 * Every place that asks for one agent role asks with this.
 *
 * A native `<select>`: the roles are a flat list of names, and on iOS the
 * system picker is the most comfortable way to choose from one.
 */
export default function RoleSelect({
	value,
	onChange,
	emptyLabel,
	...rest
}: Props) {
	const roles = useAgentRoleStore((s) => s.roles);

	// An id with no role behind it is a transient the list will settle: offering
	// it as a row of its own keeps the field from showing, even for a frame, a
	// role — or an empty choice — that is not the one stored.
	const isDangling = value !== "" && !roles.some((r) => r.id === value);

	return (
		<select
			{...rest}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className={`min-h-[44px] w-full rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary ${inputClass}`}
		>
			{emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
			{isDangling && <option value={value}>Unknown role</option>}
			{roles.map((role) => (
				<option key={role.id} value={role.id}>
					{role.name}
				</option>
			))}
		</select>
	);
}
