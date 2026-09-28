import { ExternalLink } from "lucide-react";
import { AGENT_CLI_INFO, getAgentLabel } from "../../lib/agentType";
import type { CliAccount, CliExternal } from "../../types/cliAuth";
import type { AgentType } from "../../types/settings";
import { cardTextButtonClass, primaryButtonClass } from "./loginParts";

// The wording the card and the sheet share, so one state never reads two ways
// (docs/cli-login-ui.md, "The card states").

/**
 * "ada@example.com · Max", or whichever of the two the CLI reported. Empty
 * when it reported neither — never "unknown account".
 */
export function accountSummary(account: CliAccount | undefined): string {
	if (!account) return "";
	// Codex reports "unknown" for a plan it cannot name, which says nothing.
	const plan =
		account.plan && account.plan !== "unknown" ? capitalize(account.plan) : "";
	return [account.email, plan].filter(Boolean).join(" · ");
}

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

const CLOUD_PROVIDERS: Record<string, string> = {
	bedrock: "Amazon Bedrock",
	vertex: "Google Vertex AI",
	foundry: "Microsoft Foundry",
};

// An environment variable's name is shown as code; anything else the CLI named
// as a key's source is shown as it said it.
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Why a CLI is managed outside Pockode, naming the source and never its value,
 * then where to change it.
 */
export function ExternalSource({
	agent,
	external,
}: {
	agent: AgentType;
	external: CliExternal | undefined;
}) {
	return (
		<>{describeSource(agent, external)} Change it on the server machine.</>
	);
}

function describeSource(agent: AgentType, external: CliExternal | undefined) {
	const fallback = `${getAgentLabel(agent)} is set up with credentials Pockode doesn't manage.`;
	if (!external) return fallback;

	const provider = external.provider
		? (CLOUD_PROVIDERS[external.provider] ?? external.provider)
		: undefined;

	switch (external.kind) {
		case "api_key":
			if (external.source && ENV_NAME.test(external.source)) {
				return (
					<>
						Using <code className="font-mono">{external.source}</code> from the
						server's environment.
					</>
				);
			}
			return external.source
				? `Using an API key from ${external.source}.`
				: "Using an API key.";
		case "api_key_helper":
			return (
				<>
					Using an API key from the{" "}
					<code className="font-mono">apiKeyHelper</code> setting.
				</>
			);
		case "oauth_token":
			return "Using a token from the server's environment.";
		case "cloud_provider":
			return provider ? `Using ${provider}.` : fallback;
		case "no_sign_in_needed":
			return "Using a model provider that doesn't need an OpenAI sign-in.";
		default:
			if (provider) return `Using ${provider}.`;
			return external.method
				? `${getAgentLabel(agent)} is set up with credentials Pockode doesn't manage (${external.method}).`
				: fallback;
	}
}

export function NotInstalledHint({
	agent,
	verb = "refresh",
}: {
	agent: AgentType;
	/** What to do once it is installed. */
	verb?: "refresh" | "try again";
}) {
	return (
		<>
			Install the{" "}
			<code className="font-mono">{AGENT_CLI_INFO[agent].command}</code> CLI on
			the machine running Pockode, then {verb}.
		</>
	);
}

/** The CLI's install page, as a footer's primary action or a card's link. */
export function InstallLink({
	agent,
	variant,
}: {
	agent: AgentType;
	variant: "primary" | "text";
}) {
	return (
		<a
			href={AGENT_CLI_INFO[agent].installUrl}
			target="_blank"
			rel="noopener noreferrer"
			className={
				variant === "primary"
					? `${primaryButtonClass} flex-1`
					: `${cardTextButtonClass} text-th-accent`
			}
		>
			Install instructions
			<ExternalLink className="h-4 w-4" aria-hidden="true" />
		</a>
	);
}
