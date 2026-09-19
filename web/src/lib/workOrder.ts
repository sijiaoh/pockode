import type { WorkListItem } from "../types/work";

/**
 * The order every list of work is shown in: most recently updated first.
 *
 * One function rather than a sort at each call site, because the tie-break is
 * the half nobody reproduces from memory — and because the archive's pages are
 * cut along this same order on the server (session.ListOrder), so a second
 * version of it here would answer the seam differently from the cut it draws.
 *
 * `updated_at` is compared as a *time*, never as a string. The server writes it
 * from `time.Now()` and serialises it with that moment's own UTC offset, so one
 * list can hold both `...+09:00` and `...Z`; comparing those as text sorts them
 * by how they are spelled, which is wrong in a way that only shows up across a
 * timezone or a DST change.
 *
 * Ties go to the higher id, which is the newer work: ids are uuid v7. That is
 * the server's rule too, so the two segments really do share one order rather
 * than two that usually agree.
 */
export function byUpdatedDesc(a: WorkListItem, b: WorkListItem): number {
	const delta =
		new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
	return delta !== 0 ? delta : b.id.localeCompare(a.id);
}
