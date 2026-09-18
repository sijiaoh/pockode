import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useCallback } from "react";
import { useSidebarRefresh } from "../../../components/Layout";
import SessionList from "../../../components/Session/SessionList";
import { useRouteState } from "../../../hooks/useRouteState";
import { useSession } from "../../../hooks/useSession";
import { buildNavigation } from "../../../lib/navigation";
import { useSidebarContainer } from "../../../lib/sidebarContainerContext";

export default function SessionsTab() {
	const navigate = useNavigate();
	const { worktree, sessionId: routeSessionId } = useRouteState();
	const { onClose, isExpanded } = useSidebarContainer();
	const {
		sessions,
		currentSessionId,
		isLoading,
		createSession,
		deleteSession,
		refresh,
		hasMore,
		isLoadingMore,
		pageError,
		autoLoad,
		hasPaged,
		loadMore,
		retryLoadMore,
	} = useSession({ routeSessionId });
	const { isActive } = useSidebarRefresh("sessions", refresh);

	// One control in every state, so pressing it after a failure is the retry.
	const handleLoadMore = useCallback(() => {
		if (pageError) retryLoadMore();
		loadMore();
	}, [pageError, retryLoadMore, loadMore]);

	const handleSelectSession = useCallback(
		(id: string) => {
			navigate(
				buildNavigation({
					type: "session",
					worktree,
					sessionId: id,
				}),
			);
			if (!isExpanded) onClose();
		},
		[navigate, worktree, isExpanded, onClose],
	);

	const handleCreateSession = useCallback(async () => {
		try {
			const newSession = await createSession();
			navigate(
				buildNavigation({
					type: "session",
					worktree,
					sessionId: newSession.id,
				}),
			);
			if (!isExpanded) onClose();
		} catch (error) {
			console.error("Failed to create session:", error);
		}
	}, [createSession, navigate, worktree, isExpanded, onClose]);

	return (
		<div
			className={isActive ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
		>
			<div className="p-2">
				<button
					type="button"
					onClick={handleCreateSession}
					className="flex w-full items-center justify-center gap-2 rounded-lg bg-th-accent p-3 text-th-accent-text hover:bg-th-accent-hover"
				>
					<Plus className="size-5" aria-hidden="true" />
					New Chat
				</button>
			</div>
			<div className="flex-1 overflow-y-auto">
				{isLoading ? (
					<div className="p-4 text-center text-th-text-muted">Loading...</div>
				) : (
					<SessionList
						sessions={sessions}
						currentSessionId={currentSessionId}
						onSelectSession={handleSelectSession}
						onDeleteSession={deleteSession}
						hasMore={hasMore}
						isLoadingMore={isLoadingMore}
						pageError={pageError}
						autoLoad={autoLoad}
						hasPaged={hasPaged}
						onLoadMore={handleLoadMore}
					/>
				)}
			</div>
		</div>
	);
}
