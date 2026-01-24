import { useState } from "react";
import ConfirmDialog from "../../common/ConfirmDialog";
import SettingsSection from "../SettingsSection";

interface Props {
	id: string;
	onLogout: () => void;
}

export default function AccountSection({ id, onLogout }: Props) {
	const [showConfirm, setShowConfirm] = useState(false);

	const handleLogoutClick = () => {
		setShowConfirm(true);
	};

	const handleConfirm = () => {
		setShowConfirm(false);
		onLogout();
	};

	const handleCancel = () => {
		setShowConfirm(false);
	};

	return (
		<SettingsSection id={id} title="Account">
			<button
				type="button"
				onClick={handleLogoutClick}
				className="flex min-h-14 w-full items-center rounded-lg border border-th-border bg-th-bg-secondary px-4 text-left text-sm font-medium text-th-error transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-th-error hover:border-th-error active:scale-[0.99]"
			>
				Logout
			</button>

			{showConfirm && (
				<ConfirmDialog
					title="Logout"
					message="Are you sure you want to logout?"
					confirmLabel="Logout"
					cancelLabel="Cancel"
					variant="danger"
					onConfirm={handleConfirm}
					onCancel={handleCancel}
				/>
			)}
		</SettingsSection>
	);
}
