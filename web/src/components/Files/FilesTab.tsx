import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSidebarRefresh } from "../Layout";
import FileTree from "./FileTree";

interface Props {
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
}

function FilesTab({ onSelectFile, activeFilePath }: Props) {
	const queryClient = useQueryClient();
	const [expandSignal, setExpandSignal] = useState(0);

	const handleRefresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["contents"] });
		setExpandSignal((s) => s + 1);
	}, [queryClient]);

	const { isActive } = useSidebarRefresh("files", handleRefresh);

	const prevActiveRef = useRef(isActive);
	useEffect(() => {
		if (isActive && !prevActiveRef.current) {
			setExpandSignal((s) => s + 1);
		}
		prevActiveRef.current = isActive;
	}, [isActive]);

	return (
		<div
			className={isActive ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
		>
			<FileTree
				onSelectFile={onSelectFile}
				activeFilePath={activeFilePath}
				expandSignal={expandSignal}
			/>
		</div>
	);
}

export default FilesTab;
