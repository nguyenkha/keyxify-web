import { useEffect, useRef, useState, type RefObject } from "react";

const THRESHOLD = 80; // px pull distance to trigger refresh
const MAX_PULL = 120; // max visual pull distance

/** Pull-to-refresh hook for mobile. Attach ref to scrollable container. */
export function usePullToRefresh(
  onRefresh: () => Promise<void> | void,
  containerRef: RefObject<HTMLElement | null>,
) {
  const [pulling, setPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const active = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function onTouchStart(e: TouchEvent) {
      // Only activate when scrolled to top
      if (el!.scrollTop > 0) return;
      startY.current = e.touches[0].clientY;
      active.current = true;
    }

    function onTouchMove(e: TouchEvent) {
      if (!active.current) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy < 0) { active.current = false; setPullDistance(0); return; }
      const dist = Math.min(dy * 0.5, MAX_PULL); // dampen pull
      setPullDistance(dist);
      setPulling(dist > 10);
      if (dist > 10) e.preventDefault(); // prevent native scroll bounce
    }

    function onTouchEnd() {
      if (!active.current) return;
      active.current = false;
      if (pullDistance >= THRESHOLD) {
        setRefreshing(true);
        setPullDistance(THRESHOLD * 0.5);
        Promise.resolve(onRefresh()).finally(() => {
          setRefreshing(false);
          setPullDistance(0);
          setPulling(false);
        });
      } else {
        setPullDistance(0);
        setPulling(false);
      }
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, pullDistance]);

  return { pulling, pullDistance, refreshing };
}
