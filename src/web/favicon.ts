import { useEffect } from "react";

const SIZE = 32;
const DOT_RADIUS = 5;
const DOT_GAP = 1.5;

/**
 * While `on` holds, the tab's icon is the page's favicon with a dot in the
 * accent color at its bottom right. Both come from the page, so a deployment's
 * own favicon and brand.css still apply.
 */
export function useFaviconDot(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const original = link?.getAttribute("href");
    if (!link || !original) return;

    let cancelled = false;
    void (async () => {
      try {
        const image = new Image();
        image.src = original;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const context = canvas.getContext("2d");
        if (cancelled || !context) return;
        context.drawImage(image, 0, 0, SIZE, SIZE);
        const center = SIZE - DOT_RADIUS;
        // A transparent ring keeps the dot apart from the icon under it.
        context.globalCompositeOperation = "destination-out";
        context.beginPath();
        context.arc(center, center, DOT_RADIUS + DOT_GAP, 0, 2 * Math.PI);
        context.fill();
        context.globalCompositeOperation = "source-over";
        context.fillStyle = getComputedStyle(document.documentElement)
          .getPropertyValue("--accent")
          .trim();
        context.beginPath();
        context.arc(center, center, DOT_RADIUS, 0, 2 * Math.PI);
        context.fill();
        if (!cancelled) link.href = canvas.toDataURL("image/png");
      } catch {
        // The plain icon stays.
      }
    })();

    return () => {
      cancelled = true;
      link.setAttribute("href", original);
    };
  }, [on]);
}
