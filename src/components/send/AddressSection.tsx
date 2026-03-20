import { Scanner } from "@yudiel/react-qr-scanner";
import { getAddressSuggestions, saveAddressEntry } from "../../lib/addressBook";
import { isResolvableName } from "../../lib/nameResolution";
import type { Chain } from "../../lib/api";
import type { AddressEntry } from "../../lib/addressBook";

interface AddressSectionProps {
  chain: Chain;
  to: string;
  setTo: (v: string) => void;
  resolving: boolean;
  resolvedName: { input: string; address: string; source: string } | null;
  showAddrScanner: boolean;
  setShowAddrScanner: (v: boolean | ((prev: boolean) => boolean)) => void;
  showSuggestions: boolean;
  setShowSuggestions: (v: boolean | ((prev: boolean) => boolean)) => void;
  savingToBook: boolean;
  setSavingToBook: (v: boolean) => void;
  bookmarkLabel: string;
  setBookmarkLabel: (v: string) => void;
  setToTouched: (v: boolean) => void;
  toValid: boolean;
  toSelf: boolean;
  toError: string | null;
  placeholder: string;
  destinationTag: string;
  setDestinationTag: (v: string) => void;
  xlmMemo: string;
  setXlmMemo: (v: string) => void;
  speedUpData?: { originalTxid: string; to: string; amountSats: bigint; utxos: { txid: string; vout: number; value: number }[]; minFeeRate: number };
  t: (key: string, opts?: Record<string, unknown>) => string;
}

export function AddressSection({
  chain,
  to,
  setTo,
  resolving,
  resolvedName,
  showAddrScanner,
  setShowAddrScanner,
  showSuggestions,
  setShowSuggestions,
  savingToBook,
  setSavingToBook,
  bookmarkLabel,
  setBookmarkLabel,
  setToTouched,
  toValid,
  toSelf,
  toError,
  placeholder,
  destinationTag,
  setDestinationTag,
  xlmMemo,
  setXlmMemo,
  speedUpData,
  t,
}: AddressSectionProps) {
  const destTagValid =
    chain.type !== "xrp" ||
    destinationTag === "" ||
    (/^\d+$/.test(destinationTag) && Number(destinationTag) <= 4294967295);

  return (
    <>
      {/* To */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs text-text-muted">{t("send.to")}</label>
          {toValid && !savingToBook && (
            <button
              type="button"
              onClick={() => setSavingToBook(true)}
              className="text-[10px] text-text-muted hover:text-blue-400 transition-colors"
            >
              {t("send.saveToBook")}
            </button>
          )}
        </div>
        {savingToBook && (
          <div className="flex items-center gap-2 mb-2">
            <input
              type="text"
              value={bookmarkLabel}
              onChange={(e) => setBookmarkLabel(e.target.value)}
              placeholder={t("send.labelPlaceholder")}
              className="flex-1 bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-blue-500"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && bookmarkLabel.trim()) {
                  saveAddressEntry({ address: to, label: bookmarkLabel.trim(), chain: chain.type });
                  setSavingToBook(false);
                  setBookmarkLabel("");
                } else if (e.key === "Escape") {
                  setSavingToBook(false);
                  setBookmarkLabel("");
                }
              }}
            />
            <button
              type="button"
              onClick={() => {
                if (bookmarkLabel.trim()) {
                  saveAddressEntry({ address: to, label: bookmarkLabel.trim(), chain: chain.type });
                }
                setSavingToBook(false);
                setBookmarkLabel("");
              }}
              className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
            >
              {bookmarkLabel.trim() ? t("send.saveBookmark") : t("send.cancelBookmark")}
            </button>
          </div>
        )}
        <div className={`relative flex items-center bg-surface-primary border rounded-lg ${
          toError
            ? "border-red-500/50 focus-within:border-red-500"
            : toSelf
              ? "border-yellow-500/50 focus-within:border-yellow-500"
              : "border-border-primary focus-within:border-blue-500"
        }`}>
          <input
            type="text"
            value={to}
            onChange={(e) => { if (!speedUpData) setTo(e.target.value.trim()); }}
            onFocus={() => { if (!to && !speedUpData) setShowSuggestions(true); }}
            onBlur={() => { setToTouched(true); setTimeout(() => setShowSuggestions(false), 200); }}
            placeholder={placeholder}
            readOnly={!!speedUpData}
            className="flex-1 min-w-0 bg-transparent px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none font-mono"
          />
          {/* Address book button */}
          {!speedUpData && (
            <button
              type="button"
              className="p-1.5 mr-0.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors shrink-0"
              onClick={() => setShowSuggestions((v) => !v)}
              title={t("common.addressBook")}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
              </svg>
            </button>
          )}
          {/* Paste button — mobile only */}
          <button
            type="button"
            className="md:hidden p-1.5 mr-0.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors shrink-0"
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (text) setTo(text.trim());
              } catch { /* clipboard denied */ }
            }}
            title={t("common.paste")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </button>
          {/* Scan QR button */}
          <button
            type="button"
            className="p-1.5 mr-1 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-tertiary transition-colors shrink-0"
            onClick={() => setShowAddrScanner((v) => !v)}
            title={t("common.scanQr")}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M3 17v2a2 2 0 002 2h2" />
              <rect x="7" y="7" width="4" height="4" rx="0.5" />
              <rect x="13" y="7" width="4" height="4" rx="0.5" />
              <rect x="7" y="13" width="4" height="4" rx="0.5" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 13h4v4h-4" />
            </svg>
          </button>
        </div>
        {/* Address suggestions dropdown */}
        {showSuggestions && !speedUpData && (() => {
          const suggestions = getAddressSuggestions(chain.type);
          if (suggestions.length === 0) return null;
          return (
            <div className="mt-1 bg-surface-primary border border-border-primary rounded-lg overflow-hidden max-h-[160px] overflow-y-auto">
              {suggestions.map((s, i) => {
                const isBookmark = "label" in s;
                const addr = s.address;
                return (
                  <button
                    key={`${addr}-${i}`}
                    type="button"
                    className="w-full px-3 py-2 text-left hover:bg-surface-tertiary transition-colors flex items-center gap-2.5 border-b border-border-secondary last:border-b-0"
                    onMouseDown={(e) => { e.preventDefault(); setTo(addr); setShowSuggestions(false); }}
                  >
                    <div className="w-6 h-6 rounded-full bg-surface-tertiary flex items-center justify-center shrink-0">
                      {isBookmark ? (
                        <svg className="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z" />
                        </svg>
                      ) : (
                        <svg className="w-3 h-3 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      {isBookmark && <p className="text-xs text-text-secondary truncate">{(s as AddressEntry).label}</p>}
                      <p className="text-[11px] font-mono text-text-muted truncate">{addr}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })()}
        {showAddrScanner && (
          <div className="mt-2 rounded-lg overflow-hidden border border-border-primary">
            <Scanner
              onScan={(results) => {
                if (results.length > 0) {
                  let raw = results[0].rawValue;
                  const colonIdx = raw.indexOf(":");
                  if (colonIdx > 0 && colonIdx < 10) raw = raw.slice(colonIdx + 1);
                  const qIdx = raw.indexOf("?");
                  if (qIdx > 0) raw = raw.slice(0, qIdx);
                  setTo(raw.trim());
                  setShowAddrScanner(false);
                }
              }}
              onError={() => setShowAddrScanner(false)}
              formats={["qr_code"]}
              components={{ finder: true }}
              styles={{ container: { width: "100%" } }}
            />
          </div>
        )}
        {/* Name resolution indicator */}
        {resolving && isResolvableName(to) && (
          <div className="flex items-center gap-1.5 mt-1.5 px-0.5">
            <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-[11px] text-text-muted">{t("send.resolving", { name: to })}</p>
          </div>
        )}
        {resolvedName?.input === to && (
          <div className="flex items-center gap-1.5 mt-1.5 px-0.5">
            <svg className="w-3.5 h-3.5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <p className="text-[11px] text-text-secondary">
              <span className="text-text-muted">{resolvedName.source}:</span>{" "}
              <span className="font-mono">{resolvedName.address.slice(0, 10)}...{resolvedName.address.slice(-6)}</span>
            </p>
          </div>
        )}
        {!resolving && isResolvableName(to) && !resolvedName && to.length > 0 && (
          <p className="text-[11px] text-yellow-500/70 mt-1.5 px-0.5">{t("send.cannotResolve")}</p>
        )}
        {toError && (
          <p className="text-[10px] text-red-400 mt-1">{toError}</p>
        )}
        {toSelf && (
          <p className="text-[10px] text-yellow-400 mt-1">{t("send.ownAddress")}</p>
        )}
      </div>

      {/* Destination Tag (XRP only) */}
      {chain.type === "xrp" && (
        <div>
          <label className="block text-xs text-text-muted mb-1.5">{t("send.destinationTag")} <span className="text-text-muted/50">{t("send.destinationTagOptional")}</span></label>
          <input
            type="text"
            value={destinationTag}
            onChange={(e) => setDestinationTag(e.target.value.replace(/\D/g, ""))}
            placeholder="e.g. 12345"
            className={`w-full bg-surface-primary border rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none tabular-nums ${
              destinationTag && !destTagValid
                ? "border-red-500/50 focus:border-red-500"
                : "border-border-primary focus:border-blue-500"
            }`}
          />
          {destinationTag && !destTagValid && (
            <p className="text-[10px] text-red-400 mt-1">{t("send.destinationTagError")}</p>
          )}
        </div>
      )}

      {/* Memo (XLM only) */}
      {chain.type === "xlm" && (
        <div>
          <label className="block text-xs text-text-muted mb-1.5">{t("send.memo")} <span className="text-text-muted/50">{t("send.memoOptional")}</span></label>
          <input
            type="text"
            value={xlmMemo}
            onChange={(e) => setXlmMemo(e.target.value.slice(0, 28))}
            placeholder={t("send.memoPlaceholder")}
            className="w-full bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-blue-500"
          />
        </div>
      )}
    </>
  );
}
