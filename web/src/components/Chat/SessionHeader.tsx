import { useIsExpanded } from "@pockode/shared";
import { ChevronDown, ChevronLeft, ChevronRight, Zap } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AUTO_ID } from "../../lib/agentOptions";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import { useHeaderUIConfig } from "../../lib/registries/headerUIRegistry";
import { getSessionModeInfo, SESSION_MODES } from "../../lib/sessionMode";
import { NEW_SESSION_TITLE } from "../../lib/sessionStore";
import type { SessionDetail, SessionMode } from "../../types/message";
import type { AgentType } from "../../types/settings";
import { PanelSection } from "../ui";
import { ChoiceRow } from "../ui/ChoiceList";
import {
	HeaderTitleLines,
	headerSkeletonClass,
	headerTitleBoxClass,
	headerTitlePressableClass,
} from "../ui/HeaderTitle";
import ResponsivePanel from "../ui/ResponsivePanel";
import EngineSections, { useEngineSummary } from "./EngineSections";
import SessionUsageSection from "./SessionUsageSection";
import SessionWorkSection from "./SessionWorkSection";

interface Props {
	/** Empty until the session's row or detail has named it. */
	title: string;
	/**
	 * What the info sections describe, and null until it arrives — a state they
	 * say out loud rather than hide. The caller resolves it: a session read out
	 * of another worktree has one of its own and no entry in
	 * `sessionDetailStore` (`useViewedSession`).
	 */
	detail: SessionDetail | null;
	/** Absent when the embedder has no work pages to open. */
	onOpenWorkDetail?: (workId: string) => void;
	/**
	 * A session read out of another worktree: the engine and mode are not this
	 * screen's to change, so they are not offered at all — what is missing is
	 * the execution environment itself, not a moment's availability.
	 */
	readOnly: boolean;
	agentType: AgentType;
	model: string;
	effort: string;
	mode: SessionMode;
	/**
	 * False while the session has yet to describe itself, so the engine and the
	 * mode are placeholders. Neither is named then: the placeholder mode is the
	 * calm one, and a session running with no permission prompts must not wear
	 * the label of one that asks.
	 */
	hasSessionSettings: boolean;
	isSessionActivated: boolean;
	/** The server takes no setting change while a turn is open. */
	turnOpen: boolean;
	onAgentTypeChange: (type: AgentType) => Promise<void>;
	onModelChange: (model: string) => Promise<void>;
	onEffortChange: (effort: string) => Promise<void>;
	onModeChange: (mode: SessionMode) => Promise<void>;
}

/**
 * The session's name, and under it what runs it, as the one button in the
 * header — which opens everything there is to know or change about the session
 * in one panel. The engine, the mode and the session's facts used to be three
 * buttons on a row of their own above the composer; folding them behind the
 * title gives that row back to the conversation, and puts the two settings that
 * decide what the next message will do where they can be read at a glance.
 */
function SessionHeader({
	title,
	detail,
	onOpenWorkDetail,
	readOnly,
	agentType,
	model,
	effort,
	mode,
	hasSessionSettings,
	isSessionActivated,
	turnOpen,
	onAgentTypeChange,
	onModelChange,
	onEffortChange,
	onModeChange,
}: Props) {
	const [isOpen, setIsOpen] = useState(false);
	const [view, setView] = useState<"root" | "engine">("root");
	const triggerRef = useRef<HTMLButtonElement>(null);
	const engineRowRef = useRef<HTMLButtonElement>(null);
	const backRowRef = useRef<HTMLButtonElement>(null);
	const groupId = useId();
	const engineHintId = useId();
	const isExpanded = useIsExpanded();
	const { TitleComponent } = useHeaderUIConfig();
	const {
		EngineSelector: CustomEngineSelector,
		ModeSelector: CustomModeSelector,
	} = useChatUIConfig();

	const { agentInfo, modelLabel, effortLabel, hasLabel } = useEngineSummary({
		agentType,
		model,
		effort,
		hasSessionSettings,
	});
	const modeInfo = getSessionModeInfo(mode, agentType);
	const isYolo = mode === "yolo";

	const handleClose = useCallback(() => {
		setIsOpen(false);
		setView("root");
	}, []);

	// Focus follows the drill: into the sub-view's way back, and out again onto
	// the row that led there, so a keyboard user never lands on `<body>`.
	const previousView = useRef(view);
	useEffect(() => {
		if (previousView.current === view) return;
		previousView.current = view;
		(view === "engine" ? backRowRef : engineRowRef).current?.focus();
	}, [view]);

	// The one change that cannot wait: the server refuses settings while a turn
	// is open, and a sub-view left standing would offer exactly those.
	const settingsLocked = turnOpen || !hasSessionSettings;
	useEffect(() => {
		if (settingsLocked) setView("root");
	}, [settingsLocked]);

	const lockedReason = !hasSessionSettings
		? "Loading…"
		: turnOpen
			? "Available when the current turn ends"
			: undefined;

	// Auto names nothing about the session, so the agent stands in for it: the
	// line has to say what is running, and "Auto" alone says only that the CLI
	// decides.
	const engineText = model === AUTO_ID ? agentInfo.label : modelLabel;
	const subtitleReady = readOnly || hasLabel;
	const subtitleText = readOnly
		? "Read-only"
		: hasLabel
			? `${engineText} · ${modeInfo.label}`
			: "loading";

	const isPlaceholderTitle = title === NEW_SESSION_TITLE;
	// The values, not the glyphs: the row truncates, but a label that reported
	// only what fits would report the wrong thing. The agent waits like the rest
	// — until the settings land the agent type is a placeholder, and asserting
	// it would name Claude on a Codex session for a round trip.
	const engineRowLabel = hasSessionSettings
		? `Engine: ${agentInfo.label}, ${hasLabel ? modelLabel : "loading"}${
				hasLabel && effortLabel ? `, ${effortLabel} effort` : ""
			}`
		: "Engine: loading";

	const handleModeSelect = async (newMode: SessionMode) => {
		try {
			await onModeChange(newMode);
		} catch {
			// The caller reports the reason above the composer, which the drawer
			// covers below the expanded tier.
			handleClose();
		}
	};

	const showEngine = !readOnly && CustomEngineSelector !== null;
	const showMode = !readOnly && CustomModeSelector !== null;

	const renderEngineSection = () => {
		if (CustomEngineSelector) {
			return (
				<PanelSection title="Engine">
					<div className="px-3 pb-1">
						<CustomEngineSelector
							agentType={agentType}
							model={model}
							effort={effort}
							onAgentTypeChange={onAgentTypeChange}
							onModelChange={onModelChange}
							onEffortChange={onEffortChange}
							hasSessionSettings={hasSessionSettings}
							isSessionActivated={isSessionActivated}
							disabled={settingsLocked}
						/>
					</div>
				</PanelSection>
			);
		}
		return (
			<PanelSection title="Engine">
				{/* `aria-disabled` rather than `disabled`, as `MenuRow` does: a row
				    that cannot be focused cannot say why it is unavailable. */}
				<button
					ref={engineRowRef}
					type="button"
					onClick={settingsLocked ? undefined : () => setView("engine")}
					aria-disabled={settingsLocked || undefined}
					aria-label={engineRowLabel}
					aria-describedby={lockedReason ? engineHintId : undefined}
					className={`flex min-h-[48px] w-full items-center gap-3 px-3 text-left text-sm text-th-text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-th-accent ${
						settingsLocked
							? "cursor-not-allowed opacity-50"
							: "hover:bg-th-bg-tertiary"
					}`}
				>
					{hasSessionSettings ? (
						<agentInfo.icon className="size-4 shrink-0" aria-hidden="true" />
					) : (
						<span
							aria-hidden="true"
							className={`size-4 shrink-0 rounded-full ${headerSkeletonClass}`}
						/>
					)}
					<span className="min-w-0 flex-1">
						{hasSessionSettings ? (
							<span className="block truncate">
								{agentInfo.label}
								{hasLabel && ` · ${modelLabel}`}
								{hasLabel && effortLabel && ` · ${effortLabel}`}
							</span>
						) : (
							<span
								aria-hidden="true"
								className={`block h-3.5 w-28 ${headerSkeletonClass}`}
							/>
						)}
						{lockedReason && (
							<span
								id={engineHintId}
								className="block text-xs text-th-text-muted"
							>
								{lockedReason}
							</span>
						)}
					</span>
					<ChevronRight
						className="size-4 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
				</button>
			</PanelSection>
		);
	};

	const renderModeSection = () => (
		<PanelSection title="Permissions">
			{CustomModeSelector ? (
				<div className="px-3 pb-1">
					<CustomModeSelector
						mode={mode}
						agentType={agentType}
						onModeChange={onModeChange}
						hasSessionSettings={hasSessionSettings}
						disabled={settingsLocked}
					/>
				</div>
			) : (
				<>
					{/* min-w-0: see `Section` — the fieldset's UA min size would let a
					    long description push past the panel. */}
					<fieldset
						disabled={settingsLocked}
						aria-label="Permissions"
						className={`min-w-0 ${settingsLocked ? "opacity-50" : ""}`}
					>
						{SESSION_MODES.map((modeKey) => {
							const info = getSessionModeInfo(modeKey, agentType);
							return (
								<ChoiceRow
									key={modeKey}
									group={`${groupId}-mode`}
									value={modeKey}
									label={
										<span className="flex items-center gap-1.5">
											<info.icon
												className={`size-3.5 ${
													modeKey === "yolo" ? "text-th-warning" : ""
												}`}
												aria-hidden="true"
											/>
											{info.label}
										</span>
									}
									description={info.description}
									// No dot on the placeholder: it is the calm mode, and a
									// session running with no prompts would read as one that asks.
									selected={hasSessionSettings && mode === modeKey}
									onSelect={() => handleModeSelect(modeKey)}
								/>
							);
						})}
					</fieldset>
					{/* Outside the fieldset, whose `opacity-50` would take the one
					    line explaining it to roughly 1.6:1 against the panel. */}
					{lockedReason && (
						<p className="px-3 pt-1 text-xs text-th-text-muted">
							{lockedReason}
						</p>
					)}
				</>
			)}
		</PanelSection>
	);

	return (
		<div className="relative flex min-w-0 flex-1 items-center">
			{/* The heading wraps the button rather than sitting in it, since a
			    button holds phrasing content only — and wraps nothing else, or
			    the dropdown's whole content would join its name. */}
			<h1 className="flex min-w-0 flex-1">
				<button
					ref={triggerRef}
					type="button"
					onClick={() => (isOpen ? handleClose() : setIsOpen(true))}
					aria-haspopup="dialog"
					aria-expanded={isOpen}
					aria-label={`Session: ${title || "loading"}, ${subtitleText}`}
					title={title || undefined}
					className={`-ml-1 ${headerTitleBoxClass} ${headerTitlePressableClass}`}
				>
					<HeaderTitleLines
						title={
							title === "" ? null : TitleComponent ? (
								<TitleComponent title={title} />
							) : (
								// A session still wearing the server's name reads as a
								// placeholder rather than as something the user called it.
								<span
									className={`truncate text-sm font-semibold ${
										isPlaceholderTitle
											? "text-th-text-secondary"
											: "text-th-text-primary"
									}`}
								>
									{title}
								</span>
							)
						}
						hint={
							<ChevronDown
								className="size-3.5 shrink-0 text-th-text-muted"
								aria-hidden="true"
							/>
						}
						// Not a placeholder "Default": a session running in YOLO must
						// not wear the safe mode's name for a round trip.
						subtitle={
							!subtitleReady ? null : readOnly ? (
								"Read-only"
							) : (
								<>
									{/* The engine gives way first: the mode is the one that
									    decides whether the next turn asks before it acts. */}
									<span className="min-w-0 truncate">{engineText}</span>
									<span className="shrink-0 px-1">·</span>
									<span className="flex shrink-0 items-center gap-0.5">
										{isYolo && (
											<Zap
												className="size-3 text-th-warning"
												aria-hidden="true"
											/>
										)}
										{modeInfo.label}
									</span>
								</>
							)
						}
					/>
				</button>
			</h1>

			<ResponsivePanel
				isOpen={isOpen}
				onClose={handleClose}
				title={title || "Session"}
				triggerRef={triggerRef}
				isExpanded={isExpanded}
				desktopPosition="left"
				desktopPlacement="below"
				desktopWidth="w-96"
				// The settings and the session's facts together do not fit the
				// default heights on any phone. Taller than the other panels, still
				// short enough to read as a sheet with the conversation behind it.
				mobileMaxHeight="80dvh"
				desktopMaxHeight="70vh"
			>
				<div className="overflow-y-auto pb-2">
					{view === "engine" ? (
						<>
							<button
								ref={backRowRef}
								type="button"
								onClick={() => setView("root")}
								className="flex min-h-[48px] w-full items-center gap-2 border-b border-th-border px-3 text-left text-sm font-medium text-th-text-primary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-th-accent"
							>
								<ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
								Engine
							</button>
							<EngineSections
								agentType={agentType}
								model={model}
								effort={effort}
								onAgentTypeChange={onAgentTypeChange}
								onModelChange={onModelChange}
								onEffortChange={onEffortChange}
								onFailure={handleClose}
								isSessionActivated={isSessionActivated}
								disabled={settingsLocked}
							/>
						</>
					) : (
						<>
							{/* The drawer below the expanded tier carries the title in its
							    header; the dropdown has none, and this is the one place
							    a title the header had to truncate can be read whole. */}
							{isExpanded && title !== "" && (
								<p className="line-clamp-3 break-words px-3 pt-3 text-sm font-semibold text-th-text-primary">
									{title}
								</p>
							)}
							{/* One container for the sections, so `PanelSection`'s
							    first-child rule draws the dividers between them. The
							    settings first: they decide the next message, while the
							    facts below describe the ones already sent. */}
							<div>
								{showEngine && renderEngineSection()}
								{showMode && renderModeSection()}
								<SessionWorkSection
									detail={detail}
									onOpenWorkDetail={onOpenWorkDetail}
									onClose={handleClose}
								/>
								<SessionUsageSection
									usage={detail?.usage}
									isForked={detail?.forked_from !== undefined}
								/>
							</div>
						</>
					)}
				</div>
			</ResponsivePanel>
		</div>
	);
}

export default SessionHeader;
