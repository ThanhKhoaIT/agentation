/**
 * Returns a callback ref that applies inline `!important` styles.
 *
 * React's `style` prop cannot express `!important`, so host pages with rules like
 * `div { border: none !important }` can hide our overlays. Inline `!important`
 * is the highest-priority author style and cannot be overridden by page CSS.
 *
 * Pass `undefined` for a property to remove a previously forced value.
 */
export function forceImportantStyles(
  styles: Record<string, string | undefined>,
): (el: HTMLElement | null) => void {
  return (el) => {
    if (!el) return;
    for (const [prop, value] of Object.entries(styles)) {
      if (value === undefined) {
        el.style.removeProperty(prop);
      } else {
        el.style.setProperty(prop, value, "important");
      }
    }
  };
}
