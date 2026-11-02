import type { JSONRPCRequester } from "json-rpc-2.0";

/**
 * A page an agent drew, as the server stored it. Immutable once drawn: an
 * `html_edit` makes a new page with its own id rather than changing this one.
 */
export interface HtmlPage {
	id: string;
	title: string;
	html: string;
	/** The page this one was derived from, for a page `html_edit` made. */
	base?: string;
	created_at: string;
}

interface HtmlPageGetParams {
	session_id: string;
	id: string;
}

export interface HtmlPageGetResult {
	page: HtmlPage;
}

export interface HtmlPageActions {
	/**
	 * Reads a page of the bound worktree's session by the id its `tool_result`
	 * carries as `html_page`. Nothing to subscribe to: a page never changes.
	 */
	getHtmlPage: (sessionId: string, id: string) => Promise<HtmlPage>;
}

export function createHtmlPageActions(
	getClient: () => JSONRPCRequester<void> | null,
): HtmlPageActions {
	return {
		getHtmlPage: async (sessionId, id) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("html_page.get", {
				session_id: sessionId,
				id,
			} satisfies HtmlPageGetParams)) as HtmlPageGetResult;
			return result.page;
		},
	};
}
