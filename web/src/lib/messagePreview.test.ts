import { describe, expect, it } from "vitest";
import { messagePreview } from "./messagePreview";

describe("messagePreview", () => {
	// The fork sheet quotes this, and the input it refills gets the command as
	// typed; the two have to name the message the same way.
	it("quotes a Pockode command as typed, not as the prompt it expanded to", () => {
		expect(
			messagePreview({
				id: "u1",
				role: "user",
				content: "Lead the work just discussed…",
				status: "complete",
				createdAt: new Date(),
				command: { name: "pockode-lead", args: "backend\nfirst" },
			}),
		).toBe("/pockode-lead backend first");
	});

	// Its content is the action written out for the agent (docs/canvas-ui.md §12).
	it("quotes a canvas action by its name, not the text the agent read", () => {
		expect(
			messagePreview({
				id: "u3",
				role: "user",
				content:
					'Canvas action "create" from revision 7:\n{"title":"Fix login"}',
				status: "complete",
				createdAt: new Date(),
				canvasAction: {
					action: "create",
					data: { title: "Fix login" },
					revision: 7,
				},
			}),
		).toBe("create");
	});

	it("names a message that is only files by the files", () => {
		expect(
			messagePreview({
				id: "u2",
				role: "user",
				content: "",
				status: "complete",
				createdAt: new Date(),
				attachments: [
					{ name: "shot.png", mime: "image/png", attachment_id: "a.png" },
					{ name: "log.txt", mime: "text/plain", attachment_id: "b.txt" },
				],
			}),
		).toBe("shot.png, log.txt");
	});
});
