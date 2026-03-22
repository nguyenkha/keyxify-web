// Address book + recent recipients stored in local config (kexify:config)

import { getUserOverrides, setUserOverrides, type AddressBookEntry, type RecentRecipientEntry } from "./userOverrides";

const MAX_RECENT = 10;

export type AddressEntry = AddressBookEntry;
export type RecentRecipient = RecentRecipientEntry;

/** Get current user's identity ID from JWT */
function currentIdentityId(): string | undefined {
  try {
    const token = localStorage.getItem("secretkey_token");
    if (!token) return undefined;
    return JSON.parse(atob(token.split(".")[1])).sub;
  } catch { return undefined; }
}

/** Get overrides scoped to the current identity (userId or keyShareId) */
function findOverrides(): { overrides: ReturnType<typeof getUserOverrides>; userId?: string } {
  const userId = currentIdentityId();
  return { overrides: getUserOverrides(userId), userId };
}

// ── Address Book ──────────────────────────────────────────────────

export function getAddressBook(): AddressEntry[] {
  const { overrides } = findOverrides();
  return overrides.address_book ?? [];
}

export function saveAddressEntry(entry: Omit<AddressEntry, "added_at">): void {
  const { overrides, userId } = findOverrides();
  const book: AddressEntry[] = overrides.address_book ?? [];
  const existing = book.findIndex(
    (e) => e.address.toLowerCase() === entry.address.toLowerCase() && e.chain === entry.chain,
  );
  if (existing >= 0) {
    book[existing] = { ...entry, added_at: Date.now() };
  } else {
    book.push({ ...entry, added_at: Date.now() });
  }
  setUserOverrides({ ...overrides, address_book: book }, userId);
}

export function removeAddressEntry(address: string, chain?: string): void {
  const { overrides, userId } = findOverrides();
  const book = (overrides.address_book ?? []).filter(
    (e) => !(e.address.toLowerCase() === address.toLowerCase() && e.chain === chain),
  );
  setUserOverrides({ ...overrides, address_book: book }, userId);
}

// ── Recent Recipients ─────────────────────────────────────────────

export function getRecentRecipients(): RecentRecipient[] {
  const { overrides } = findOverrides();
  return overrides.recent_recipients ?? [];
}

export function addRecentRecipient(address: string, chain: string, asset: string): void {
  const { overrides, userId } = findOverrides();
  let recent: RecentRecipient[] = (overrides.recent_recipients ?? []).filter(
    (r) => !(r.address.toLowerCase() === address.toLowerCase() && r.chain === chain),
  );
  recent.unshift({ address, chain, asset, timestamp: Date.now() });
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  setUserOverrides({ ...overrides, recent_recipients: recent }, userId);
}

/** Get combined suggestions: address book entries first, then recent, filtered by chain */
export function getAddressSuggestions(chainType: string): (AddressEntry | RecentRecipient)[] {
  const bookEntries = getAddressBook().filter((e) => !e.chain || e.chain === chainType);
  const recentEntries = getRecentRecipients().filter((r) => r.chain === chainType);

  // Deduplicate: book entries take priority
  const seen = new Set(bookEntries.map((e) => e.address.toLowerCase()));
  const uniqueRecent = recentEntries.filter((r) => !seen.has(r.address.toLowerCase()));

  return [...bookEntries, ...uniqueRecent];
}
