/**
 * An icon button in the app header: the menu, a page's way back, the settings.
 *
 * One definition because the three sit on one row and have to read as one
 * weight. 44px of box on every pointer: the header is 44px tall at its
 * shortest, so the box costs nothing to give a thumb, and no border or fill so
 * the row stays quieter than whatever the page is showing below it.
 */
export const headerIconButtonClass =
	"flex size-11 shrink-0 items-center justify-center rounded text-th-text-muted transition-all hover:bg-th-bg-tertiary hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent active:scale-95";
