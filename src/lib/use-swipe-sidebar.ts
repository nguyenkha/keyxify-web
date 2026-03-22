import { useEffect, useRef } from "react";

const EDGE_ZONE = 30; // px from left edge to start swipe
const SWIPE_THRESHOLD = 60; // px to trigger open
const CLOSE_THRESHOLD = 60; // px to trigger close

/**
 * Swipe-right from left edge to open sidebar, swipe-left on overlay to close.
 * Only active on touch devices (mobile/tablet).
 */
export function useSwipeSidebar(
  isOpen: boolean,
  setOpen: (open: boolean) => void,
) {
  const touchRef = useRef<{ startX: number; startY: number; tracking: boolean }>({
    startX: 0,
    startY: 0,
    tracking: false,
  });

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      // Open: must start from left edge
      // Close: can start anywhere when sidebar is open
      if (!isOpen && touch.clientX > EDGE_ZONE) return;
      touchRef.current = { startX: touch.clientX, startY: touch.clientY, tracking: true };
    }

    function onTouchEnd(e: TouchEvent) {
      if (!touchRef.current.tracking) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchRef.current.startX;
      const dy = Math.abs(touch.clientY - touchRef.current.startY);
      touchRef.current.tracking = false;

      // Ignore mostly-vertical swipes
      if (dy > Math.abs(dx)) return;

      if (!isOpen && dx > SWIPE_THRESHOLD) {
        setOpen(true);
      } else if (isOpen && dx < -CLOSE_THRESHOLD) {
        setOpen(false);
      }
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isOpen, setOpen]);
}
