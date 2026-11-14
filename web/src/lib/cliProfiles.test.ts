import { describe, expect, it } from "vitest";
import type { CliAuthStatus } from "../types/cliAuth";
import type { CliProfileOverview } from "../types/cliProfile";
import {
	chosenProfileIdOf,
	currentProfileIdOf,
	isSigningInHere,
	liveProfileName,
	profileIdsOf,
	profileName,
	profilesSharedExternal,
	recordedProfile,
	removeRefusalText,
	sharedExternal,
} from "./cliProfiles";

const WORK = "0199a000-0000-7000-8000-000000000001";
// Inline rather than from test/cliAuthFixtures, which loads the stores.
const overview: CliProfileOverview = {
	available: true,
	clis: [
		{
			agent: "claude",
			current_profile_id: WORK,
			profiles: [{ id: WORK, name: "Work" }],
		},
		{ agent: "codex", profiles: [] },
	],
};

describe("cliProfiles", () => {
	it("lists the default profile first, alone before any list", () => {
		expect(profileIdsOf(overview, "claude")).toEqual(["", WORK]);
		expect(profileIdsOf(null, "claude")).toEqual([""]);
		expect(currentProfileIdOf(overview, "claude")).toBe(WORK);
		expect(currentProfileIdOf(overview, "codex")).toBe("");
		expect(currentProfileIdOf(null, "codex")).toBeUndefined();
	});

	// Where profiles cannot be used the CLI runs as its default profile, and
	// the choice is still shown for the processes that can.
	it("runs as the default profile where profiles cannot be used", () => {
		const unavailable = { ...overview, available: false };
		expect(currentProfileIdOf(unavailable, "claude")).toBe("");
		expect(chosenProfileIdOf(unavailable, "claude")).toBe(WORK);
	});

	// A record keeps the id only: the name is looked up now, and a record
	// without one predates accounts — unknown, not the default.
	it("tells apart the accounts a record can name", () => {
		expect(recordedProfile(overview, "claude", undefined)).toEqual({
			kind: "unknown",
		});
		expect(recordedProfile(null, "claude", "")).toEqual({ kind: "default" });
		expect(recordedProfile(overview, "claude", WORK)).toEqual({
			kind: "named",
			name: "Work",
		});
		expect(recordedProfile(overview, "claude", "gone")).toEqual({
			kind: "removed",
		});
		expect(recordedProfile(null, "claude", WORK)).toBeNull();
	});

	it("draws only the profile a sign-in is for as signing in", () => {
		const signingIn: CliAuthStatus = {
			agent: "claude",
			state: "signing_in",
			login_profile_id: WORK,
		};
		expect(isSigningInHere(signingIn)).toBe(false);
		expect(isSigningInHere({ ...signingIn, profile_id: WORK })).toBe(true);
		expect(isSigningInHere({ agent: "claude", state: "signing_in" })).toBe(
			true,
		);
	});

	// The same environment credentials on every profile mean switching does
	// nothing; on one profile only, they are that profile's own sign-in.
	it("finds credentials every profile shares", () => {
		const env: CliAuthStatus = {
			agent: "claude",
			state: "external",
			external: { kind: "api_key", source: "ANTHROPIC_API_KEY" },
		};
		expect(sharedExternal([env, { ...env, profile_id: WORK }])).toEqual(
			env.external,
		);
		expect(sharedExternal([env])).toBeNull();
		expect(
			sharedExternal([env, { agent: "claude", state: "signed_in" }]),
		).toBeNull();
		expect(
			sharedExternal([
				env,
				{ ...env, external: { kind: "api_key", source: "codex auth.json" } },
			]),
		).toBeNull();
	});

	// One slow read must not hold the answer up once another already differs.
	it("judges every profile alike as soon as the reads in allow", () => {
		const env: CliAuthStatus = {
			agent: "claude",
			state: "external",
			external: { kind: "api_key", source: "ANTHROPIC_API_KEY" },
		};
		const ids = ["", WORK];
		expect(profilesSharedExternal(ids, undefined)).toBeUndefined();
		expect(
			profilesSharedExternal(ids, { "": { status: env } }),
		).toBeUndefined();
		expect(
			profilesSharedExternal(ids, {
				"": { status: { agent: "claude", state: "signed_in" } },
			}),
		).toBeNull();
		expect(
			profilesSharedExternal(ids, {
				"": { status: env },
				[WORK]: { status: { ...env, profile_id: WORK } },
			}),
		).toEqual(env.external);
	});

	it("never calls an account live state names removed", () => {
		expect(liveProfileName(overview, "claude", "")).toBe("Default");
		expect(liveProfileName(overview, "claude", WORK)).toBe("Work");
		expect(liveProfileName(overview, "claude", "elsewhere")).toBeUndefined();
		expect(liveProfileName(null, "claude", WORK)).toBeUndefined();
	});

	it("names an account for the screen, a removed one included", () => {
		expect(profileName(overview, "claude", "")).toBe("Default");
		expect(profileName(overview, "claude", WORK)).toBe("Work");
		expect(profileName(overview, "claude", "gone")).toBe("a removed account");
	});

	it("names the account the CLI is signing in only when it is another one", () => {
		const refusal = {
			reason: "signing_in" as const,
			sessions: [],
			message: "busy",
		};
		expect(
			removeRefusalText(refusal, {
				label: "Claude",
				name: "Work",
				signingIn: "Spare",
			}).body,
		).toBe(
			"Claude is signing in Spare. Finish or cancel that sign-in, then try again.",
		);
		expect(
			removeRefusalText(refusal, { label: "Claude", name: "Work" }).body,
		).toMatch(/^Claude is signing in\. /);
	});

	it("words a failed sign-out apart when the CLI is not installed", () => {
		const refusal = {
			reason: "sign_out_failed" as const,
			sessions: [],
			message: "claude auth logout: exit 1",
		};
		expect(
			removeRefusalText(refusal, { label: "Claude", name: "Work" }),
		).toMatchObject({ details: "claude auth logout: exit 1" });
		expect(
			removeRefusalText(refusal, {
				label: "Claude",
				name: "Work",
				notInstalled: true,
			}),
		).toEqual({
			body: "Claude isn't installed, so Work can't be signed out first. Install Claude, then remove it.",
		});
	});
});
