/**
 * Client-side browser Notification API wrapper.
 * Shows native notifications when the app tab is not focused (PWA foreground).
 */

/** Request notification permission. Call once on app init. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

/** Check if notifications are allowed */
export function canNotify(): boolean {
  return "Notification" in window && Notification.permission === "granted";
}

interface NotifyOptions {
  title: string;
  body?: string;
  icon?: string;
  /** Focus app window when notification is clicked (default: true) */
  focusOnClick?: boolean;
}

/**
 * Show a browser notification only when the tab is not focused.
 * When the tab is visible, the user already sees in-app UI — no need to spam.
 */
export function notify({ title, body, icon, focusOnClick = true }: NotifyOptions): void {
  if (!canNotify()) return;
  // Skip if user is already looking at the app
  if (document.visibilityState === "visible") return;

  const n = new Notification(title, {
    body,
    icon: icon || "/icon-192.png",
  });

  if (focusOnClick) {
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }
}
