import type { ComponentProps } from "react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { roleAcceptsWorkType, workTypeSuffix } from "../../lib/roleWorkType";
import type { AgentRole } from "../../types/agentRole";
import type { WorkType } from "../../types/work";
import { inputClass } from "../ui/inputClass";

type Props = Omit<
	ComponentProps<"select">,
	"value" | "onChange" | "className" | "children"
> & {
	value: string;
	onChange: (roleId: string) => void;
	/** Offers `""` as a choice under this label; omit it to offer no empty choice. */
	emptyLabel?: string;
	/** The kind of work the role is for: only roles that take it are offered. */
	workType: WorkType;
};

const labelWithSuffix = (role: AgentRole) => {
	const suffix = workTypeSuffix(role);
	return suffix ? `${role.name} — ${suffix}` : role.name;
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
	workType,
	...rest
}: Props) {
	const roles = useAgentRoleStore((s) => s.roles);

	// An id with no role behind it is a transient the list will settle: offering
	// it as a row of its own keeps the field from showing, even for a frame, a
	// role — or an empty choice — that is not the one stored.
	const current = roles.find((r) => r.id === value);
	const isDangling = value !== "" && !current;

	// A stored role that cannot take this kind is still the stored one — the
	// server keeps assignments made before the restriction — so it stays, named
	// with the reason it would not be offered.
	const options = roles.filter(
		(r) => r === current || roleAcceptsWorkType(r, workType),
	);

	return (
		<select
			{...rest}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className={`min-h-[44px] w-full rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary ${inputClass}`}
		>
			{emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
			{isDangling && <option value={value}>Unknown role</option>}
			{options.map((role) => (
				<option key={role.id} value={role.id}>
					{roleAcceptsWorkType(role, workType)
						? role.name
						: labelWithSuffix(role)}
				</option>
			))}
		</select>
	);
}
