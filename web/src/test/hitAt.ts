/** What a press at the middle of `element` would land on. */
export function hitAt(element: Element) {
	const box = element.getBoundingClientRect();
	return document.elementFromPoint(
		box.left + box.width / 2,
		box.top + box.height / 2,
	);
}
