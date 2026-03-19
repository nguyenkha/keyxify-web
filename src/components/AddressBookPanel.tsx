import { useState, useMemo } from "react";
import { getAddressBook, removeAddressEntry, saveAddressEntry, getRecentRecipients, type AddressEntry } from "../lib/addressBook";
import { getChainAdapter } from "../lib/chains/adapter";
import type { ChainType } from "../shared/types";

const CHAIN_OPTIONS: { value: ChainType; label: string }[] = [
  { value: "evm", label: "EVM (ETH, etc.)" },
  { value: "btc", label: "Bitcoin" },
  { value: "bch", label: "Bitcoin Cash" },
  { value: "ltc", label: "Litecoin" },
  { value: "solana", label: "Solana" },
  { value: "xrp", label: "XRP" },
  { value: "xlm", label: "Stellar" },
  { value: "tron", label: "TRON" },
];

/** Validate address for the selected chain type */
function validateAddress(address: string, chainType: string): string | null {
  if (!address.trim()) return "Address is required";
  if (!chainType) return "Select a chain first";
  try {
    const adapter = getChainAdapter(chainType as ChainType);
    if (!adapter.isValidAddress(address.trim())) {
      return `Invalid ${chainType.toUpperCase()} address`;
    }
  } catch {
    return "Invalid chain type";
  }
  return null;
}

/** Standalone address book management UI for the settings page */
export function AddressBookPanel() {
  const [entries, setEntries] = useState(() => getAddressBook());
  const [recentRecipients] = useState(() => getRecentRecipients());
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [newAddr, setNewAddr] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newChain, setNewChain] = useState("");
  const [touched, setTouched] = useState(false);

  // Validate address when chain is selected and address is entered
  const addrError = useMemo(() => {
    if (!touched || !newAddr.trim()) return null;
    return validateAddress(newAddr, newChain);
  }, [newAddr, newChain, touched]);

  function handleRemove(entry: AddressEntry) {
    removeAddressEntry(entry.address, entry.chain);
    setEntries(getAddressBook());
  }

  function handleEditSave(entry: AddressEntry) {
    saveAddressEntry({ address: entry.address, label: editLabel.trim(), chain: entry.chain });
    setEditing(null);
    setEntries(getAddressBook());
  }

  function handleAdd() {
    if (!newAddr.trim() || !newChain) return;
    const error = validateAddress(newAddr, newChain);
    if (error) { setTouched(true); return; }
    saveAddressEntry({ address: newAddr.trim(), label: newLabel.trim() || "", chain: newChain });
    setNewAddr("");
    setNewLabel("");
    setNewChain("");
    setTouched(false);
    setAdding(false);
    setEntries(getAddressBook());
  }

  function shortAddr(addr: string): string {
    if (addr.length <= 20) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2 px-1">
        <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">
          Address Book
        </p>
        <button
          onClick={() => { setAdding(!adding); setTouched(false); setNewAddr(""); setNewLabel(""); setNewChain(""); }}
          className="text-[10px] text-blue-400 hover:text-blue-300 font-medium transition-colors"
        >
          {adding ? "Cancel" : "+ Add"}
        </button>
      </div>

      <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden">
        {/* Add new entry form */}
        {adding && (
          <div className="px-3 md:px-5 py-3 border-b border-border-secondary space-y-2">
            {/* Chain selector */}
            <select
              value={newChain}
              onChange={(e) => { setNewChain(e.target.value); if (newAddr) setTouched(true); }}
              className="w-full bg-surface-primary border border-border-primary rounded-md px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-blue-500/50"
            >
              <option value="">Select chain...</option>
              {CHAIN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>

            {/* Address input */}
            <div>
              <input
                value={newAddr}
                onChange={(e) => { setNewAddr(e.target.value); setTouched(true); }}
                placeholder={newChain ? `Enter ${newChain.toUpperCase()} address` : "Address"}
                className={`w-full bg-surface-primary border rounded-md px-3 py-2 text-xs text-text-primary font-mono placeholder:text-text-muted/50 focus:outline-none ${
                  addrError ? "border-red-500/50 focus:border-red-500/70" : "border-border-primary focus:border-blue-500/50"
                }`}
              />
              {addrError && (
                <p className="text-[10px] text-red-400 mt-1 px-0.5">{addrError}</p>
              )}
            </div>

            {/* Label + save */}
            <div className="flex flex-wrap gap-2">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label (optional)"
                className="flex-1 min-w-[120px] bg-surface-primary border border-border-primary rounded-md px-3 py-2 text-xs text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-blue-500/50"
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
              <button
                onClick={handleAdd}
                disabled={!newAddr.trim() || !newChain || !!addrError}
                className="px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Save
              </button>
            </div>
          </div>
        )}

        {/* Saved entries */}
        {entries.length > 0 ? (
          <div className="divide-y divide-border-secondary">
            {entries.map((entry) => {
              const key = `${entry.address}:${entry.chain ?? ""}`;
              const isEditing = editing === key;
              return (
                <div key={key} className="px-3 md:px-5 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleEditSave(entry);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        className="w-full bg-surface-primary border border-blue-500/50 rounded-md px-2 py-1 text-xs text-text-primary focus:outline-none"
                        placeholder="Label"
                      />
                    ) : (
                      <>
                        {entry.label && (
                          <p className="text-xs font-medium text-text-primary">{entry.label}</p>
                        )}
                        <p className="text-[11px] text-text-muted font-mono truncate">{shortAddr(entry.address)}</p>
                        {entry.chain && (
                          <span className="text-[9px] text-text-muted/60 uppercase">{entry.chain}</span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isEditing ? (
                      <button
                        onClick={() => handleEditSave(entry)}
                        className="text-[10px] text-blue-400 hover:text-blue-300 font-medium"
                      >
                        Save
                      </button>
                    ) : (
                      <button
                        onClick={() => { setEditing(key); setEditLabel(entry.label ?? ""); }}
                        className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors"
                        title="Edit label"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => handleRemove(entry)}
                      className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-500/5 transition-colors"
                      title="Remove"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : !adding ? (
          <div className="px-4 py-6 text-center">
            <p className="text-xs text-text-muted">No saved addresses</p>
            <p className="text-[11px] text-text-muted/60 mt-0.5">Save addresses when sending, or add them here.</p>
          </div>
        ) : null}

        {/* Recent recipients section */}
        {recentRecipients.length > 0 && (
          <>
            <div className="px-3 md:px-5 py-2 bg-surface-tertiary/30 border-t border-border-secondary">
              <p className="text-[10px] text-text-muted/60 uppercase tracking-wider font-semibold">Recent Recipients</p>
            </div>
            <div className="divide-y divide-border-secondary">
              {recentRecipients.slice(0, 5).map((r, i) => (
                <div key={`${r.address}-${i}`} className="px-3 md:px-5 py-2.5 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-text-muted font-mono truncate">{shortAddr(r.address)}</p>
                    <span className="text-[9px] text-text-muted/60 uppercase">{r.chain} · {r.asset}</span>
                  </div>
                  <button
                    onClick={() => {
                      saveAddressEntry({ address: r.address, label: "", chain: r.chain });
                      setEntries(getAddressBook());
                    }}
                    className="text-[10px] text-blue-400 hover:text-blue-300 font-medium shrink-0"
                  >
                    Save
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
