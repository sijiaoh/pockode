// The marketing suite's project before there is a story in it: storyboard
// shots 1 and 2 (docs/marketing-assets.md §4.4), the empty project screen and
// the story created on it. A suite of its own, on a server of its own, because
// the marketing suite has the story running before its first scene — and a
// story made here would otherwise be in every one of that suite's shots.
// Everything else, the look and what pins it included, is that suite's.

import { BASE_URL, settle } from "../harness.mjs";
import { STORY } from "../marketing/scenarios.mjs";
import marketing, { englishRoles, shown } from "../marketing/scenes.mjs";

async function openProject(page) {
	await page.goto(`${BASE_URL}/works`);
	const newStory = page.getByRole("button", { name: "New Story" });
	await newStory.waitFor();
	await settle(page);
	return newStory;
}

const SCENES = [
	{
		name: "empty",
		run: async ({ page, shot }) => {
			await openProject(page);
			await shot("project-empty");
		},
	},
	{
		// Creates the story, so it runs after `empty`, and only once.
		name: "create",
		run: async ({ page, shot, sending }) => {
			await (await openProject(page)).click();
			const sheet = page.getByRole("dialog");
			const title = sheet.getByLabel("Title");
			const create = sheet.getByRole("button", { name: "Create" });
			// The role arrives after the sheet opens; until it does, the field
			// reads "Select role...".
			await sheet
				.locator("select")
				.filter({ has: page.locator("option:checked", { hasText: "PM" }) })
				.waitFor();
			await settle(page);
			await shot("new-story", { tap: title });
			await title.fill(STORY.title);
			await settle(page);
			await shot("new-story-filled", { tap: create });
			sending();
			await create.click();
			await shown(page, "Start").waitFor();
			await settle(page);
			await shot("story-new");
		},
	},
];

export default {
	...marketing,
	name: "marketing-intro",
	// Beside the marketing suite's shots: one storyboard draws from both.
	dir: "marketing",
	viewports: ["390x804"],
	scenes: SCENES,
	async setup({ rpc }) {
		await englishRoles(rpc);
		// The chat the app would open of its own on a server with none, and
		// take the page from the project screen to: made here, the first scene
		// finds what every later one does.
		await rpc.call("session.create", {});
		return {};
	},
};
