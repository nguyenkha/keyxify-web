// Address book + recent recipients stored in local config (kexify:config)

import { getUserOverrides, setUserOverrides, type AddressBookEntry, type RecentRecipientEntry } from "./userOverrides";

const MAX_RECENT = 10;

export type AddressEntry = AddressBookEntry;
export type RecentRecipient = RecentRecipientEntry;

/** Scan all kexify:config entries for the first one that has data */
function findOverrides(): { overrides: ReturnType<typeof getUserOverrides>; userId?: string } {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("kexify:config:")) {
      try {
        const parsed = JSON.parse(localStorage.getItem(k)!);
        const userId = k.replace("kexify:config:", "");
        return { overrides: parsed, userId };
      } catch { /* skip */ }
    }
  }
  return { overrides: getUserOverrides() };
}

// ── Address Book ──────────────────────────────────────────────────

export function getAddressBook(): AddressEntry[] {
  const { overrides } = findOverrides();
  return overrides.addressBook ?? [];
}

export function saveAddressEntry(entry: Omit<AddressEntry, "addedAt">): void {
  const { overrides, userId } = findOverrides();
  const book: AddressEntry[] = overrides.addressBook ?? [];
  const existing = book.findIndex(
    (e) => e.address.toLowerCase() === entry.address.toLowerCase() && e.chain === entry.chain,
  );
  if (existing >= 0) {
    book[existing] = { ...entry, addedAt: Date.now() };
  } else {
    book.push({ ...entry, addedAt: Date.now() });
  }
  setUserOverrides({ ...overrides, addressBook: book }, userId);
}

export function removeAddressEntry(address: string, chain?: string): void {
  const { overrides, userId } = findOverrides();
  const book = (overrides.addressBook ?? []).filter(
    (e) => !(e.address.toLowerCase() === address.toLowerCase() && e.chain === chain),
  );
  setUserOverrides({ ...overrides, addressBook: book }, userId);
}

// ── Recent Recipients ─────────────────────────────────────────────

export function getRecentRecipients(): RecentRecipient[] {
  const { overrides } = findOverrides();
  return overrides.recentRecipients ?? [];
}

export function addRecentRecipient(address: string, chain: string, asset: string): void {
  const { overrides, userId } = findOverrides();
  let recent: RecentRecipient[] = (overrides.recentRecipients ?? []).filter(
    (r) => !(r.address.toLowerCase() === address.toLowerCase() && r.chain === chain),
  );
  recent.unshift({ address, chain, asset, timestamp: Date.now() });
  if (recent.length > MAX_RECENT) recent = recent.slice(0, MAX_RECENT);
  setUserOverrides({ ...overrides, recentRecipients: recent }, userId);
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
