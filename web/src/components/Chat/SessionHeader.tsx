import { useIsExpanded } from "@pockode/shared";
import { Bot, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	useModeConfirmation,
	useReviewerEngineLabel,
} from "../../hooks/useModeConfirmation";
import { AUTO_ID } from "../../lib/agentOptions";
import { hasPermissionReviewer } from "../../lib/agentType";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import { useHeaderUIConfig } from "../../lib/registries/headerUIRegistry";
import {
	getSessionModeInfo,
	isKnownSessionMode,
	SESSION_MODES,
} from "../../lib/sessionMode";
import { NEW_SESSION_TITLE } from "../../lib/sessionStore";
import { getSessionStyleInfo } from "../../lib/sessionStyle";
import type {
	ReportedSessionMode,
	SessionDetail,
	SessionMode,
} from "../../types/message";
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
	/**
	 * A permission reviewer session (docs/unattended-mode-ui.md §5): its engine
	 * and mode are Pockode's, so the panel states the engine its next reviews
	 * run on instead of offering a selector, and has no Permissions.
	 */
	isPermissionReviewer?: boolean;
	/** Opens Settings, where a reviewer's engine is chosen. */
	onOpenSettings?: () => void;
	agentType: AgentType;
	model: string;
	effort: string;
	mode: ReportedSessionMode;
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
	isPermissionReviewer = false,
	onOpenSettings,
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
	const modeInfo = getSessionModeInfo(mode);
	const modeKnown = isKnownSessionMode(mode);
	const { confirm: confirmMode, dialog: modeDialog } = useModeConfirmation(
		"session",
		agentType,
	);
	// Every way a mode is chosen goes through the confirmation, a custom
	// selector's included: nothing is sent until Unattended is confirmed.
	const requestModeChange = async (newMode: SessionMode) => {
		if (await confirmMode(newMode)) await onModeChange(newMode);
	};

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
	// A reviewer's stored mode means nothing; what it is does. Its engine is the
	// session's own, which the server writes as each review is sent — so this
	// line is what the *last* review ran on.
	const modeText = isPermissionReviewer
		? "Permission reviewer"
		: modeInfo.label;
	const subtitleText = readOnly
		? "Read-only"
		: hasLabel
			? `${engineText} · ${modeText}`
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
			await requestModeChange(newMode);
		} catch {
			// The caller reports the reason above the composer, which the drawer
			// covers below the expanded tier.
			handleClose();
		}
	};

	const showEngine =
		!readOnly && !isPermissionReviewer && CustomEngineSelector !== null;
	const showMode =
		!readOnly && !isPermissionReviewer && CustomModeSelector !== null;

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
						onModeChange={requestModeChange}
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
							const info = getSessionModeInfo(modeKey);
							return (
								<ChoiceRow
									key={modeKey}
									group={`${groupId}-mode`}
									value={modeKey}
									label={
										<span className="flex items-center gap-1.5">
											<info.icon
												className={`size-3.5 ${info.iconClassName ?? ""}`}
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
					{hasSessionSettings && !modeKnown && (
						<p className="px-3 pt-1 text-xs text-th-text-muted">
							Current mode: “{mode}”, which this version doesn't know. Choose
							one to replace it.
						</p>
					)}
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
						// not wear the name of the mode that keeps its gates for a
						// round trip.
						subtitle={
							!subtitleReady ? null : readOnly ? (
								"Read-only"
							) : (
								<>
									{/* The engine gives way first: the mode is the one that
									    says whether the agent's own permission settings
									    still stand. */}
									<span className="min-w-0 truncate">{engineText}</span>
									<span className="shrink-0 px-1">·</span>
									{isPermissionReviewer ? (
										<span className="flex shrink-0 items-center gap-0.5">
											<Bot
												className="size-3 text-th-text-muted"
												aria-hidden="true"
											/>
											{modeText}
										</span>
									) : (
										<span className="flex shrink-0 items-center gap-0.5">
											{modeInfo.iconClassName && (
												<modeInfo.icon
													className={`size-3 ${modeInfo.iconClassName}`}
													aria-hidden="true"
												/>
											)}
											{modeInfo.label}
										</span>
									)}
								</>
							)
						}
					/>
				</button>
			</h1>

			{/* Outside the panel, which a refused change closes. Before it: the
			    drawer locks the body by hand, outside the dialog's counted lock,
			    so when both go in one commit the dialog has to restore first, or
			    it puts back the "hidden" it found and the page stays locked. */}
			{modeDialog}
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
								{/* A Codex reviewer an earlier version created gets no
								    more reviews: Codex has no reviewer now. */}
								{isPermissionReviewer &&
									!readOnly &&
									hasPermissionReviewer(agentType) && (
										<NextReviewsSection
											onOpenSettings={
												onOpenSettings
													? () => {
															handleClose();
															onOpenSettings();
														}
													: undefined
											}
										/>
									)}
								{detail?.html_first && detail.started && <HtmlFirstSection />}
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

/**
 * A reviewer's engine as a fact, read from the settings rather than the
 * session: not a selector, since the server refuses one, and the session's own
 * engine is the last review's, which the header already says. Right after a
 * settings change the two differ, and each says which it is.
 */
function NextReviewsSection({
	onOpenSettings,
}: {
	onOpenSettings?: () => void;
}) {
	const engine = useReviewerEngineLabel();
	const text = `Next reviews: ${engine ?? "loading"}`;
	const content = (
		<>
			<Bot className="size-4 shrink-0 text-th-text-muted" aria-hidden="true" />
			<span className="min-w-0 flex-1">
				<span className="block truncate">{text}</span>
				<span className="block text-xs text-th-text-muted">
					Chosen in Settings › Session
				</span>
			</span>
		</>
	);
	return (
		<PanelSection title="Engine">
			{onOpenSettings ? (
				<button
					type="button"
					onClick={onOpenSettings}
					aria-label={`${text}. Open Settings`}
					className="flex min-h-[48px] w-full items-center gap-3 px-3 text-left text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-th-accent"
				>
					{content}
					<ChevronRight
						className="size-4 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
				</button>
			) : (
				<div className="flex min-h-[48px] items-center gap-3 px-3 text-sm text-th-text-primary">
					{content}
				</div>
			)}
		</PanelSection>
	);
}

/**
 * The fixed choice, read-only: before the start the switch on the screen is
 * the one place to read it, and a Chat session gets no section — the default
 * needs no mention (docs/html-first-session-ui.md §4).
 */
function HtmlFirstSection() {
	const { label, icon: Icon } = getSessionStyleInfo("html_first");
	return (
		<PanelSection title="Session">
			<div className="flex items-start gap-2 px-3 py-2">
				<Icon
					className="mt-0.5 size-4 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<div className="min-w-0">
					<p className="text-sm text-th-text-primary">{label}</p>
					<p className="text-xs text-th-text-muted">
						Fixed when the first message was sent.
					</p>
				</div>
			</div>
		</PanelSection>
	);
}

export default SessionHeader;
