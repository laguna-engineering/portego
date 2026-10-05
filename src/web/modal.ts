import { type RefObject, useEffect } from "react";

/**
 * Focuses the dialog, closes it on Escape, keeps Tab inside it, and gives the
 * focus back to whatever opened it.
 */
export function useModal(dialog: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Focus lands on the dialog itself, so a screen reader announces what
    // opened before the fields are read.
    dialog.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;

      // Tab stays inside the dialog. Everything behind it is inert while it is
      // open, so leaving would strand the focus ring somewhere unusable.
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hasAttribute("disabled"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus?.();
    };
  }, [dialog, onClose]);
}
