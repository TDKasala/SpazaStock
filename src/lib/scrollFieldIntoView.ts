const PADDING_PX = 12;

function precedingAlert(field: HTMLElement, container: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = field;
  while (node && node !== container) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling instanceof HTMLElement) {
        if (sibling.getAttribute('role') === 'alert') return sibling;
        const nested = sibling.querySelector<HTMLElement>('[role="alert"]');
        if (nested) return nested;
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

/** Scrolls a dialog field into its own scroller, including a validation message directly above it. */
export function scrollFieldIntoView(field: HTMLElement, container: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  const alertRect = precedingAlert(field, container)?.getBoundingClientRect();
  const top = alertRect ? Math.min(fieldRect.top, alertRect.top) : fieldRect.top;
  const bottom = fieldRect.bottom;
  const visibleTop = containerRect.top + PADDING_PX;
  const visibleBottom = containerRect.bottom - PADDING_PX;

  let next = container.scrollTop;
  if (top < visibleTop) {
    next -= visibleTop - top;
  } else if (bottom > visibleBottom) {
    const delta = bottom - visibleBottom;
    const room = top - visibleTop;
    next += Math.min(delta, Math.max(0, room));
  } else {
    return;
  }

  container.scrollTo({ top: Math.max(0, next), behavior: 'smooth' });
}
