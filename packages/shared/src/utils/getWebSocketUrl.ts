/**
 * Constructs a WebSocket URL from a base URL.
 *
 * @param baseUrl - The base URL to derive the WebSocket URL from.
 *                  If not provided, defaults to window.location.origin.
 * @returns The WebSocket URL with appropriate protocol (ws or wss).
 *
 * @example
 * // Using window.location (default)
 * getWebSocketUrl() // "wss://example.com/ws"
 *
 * // Using custom base URL
 * getWebSocketUrl("https://api.example.com") // "wss://api.example.com/ws"
 */
export function getWebSocketUrl(baseUrl?: string): string {
	const url = baseUrl ?? window.location.origin;
	const wsProtocol = url.startsWith("https") ? "wss" : "ws";
	const host = url.replace(/^https?:\/\//, "");
	return `${wsProtocol}://${host}/ws`;
}
