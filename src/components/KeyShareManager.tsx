import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { listKeyShares, deleteKeyShare, saveKeyShareWithPrf, saveKeyShareWithPassphrase, hasKeyShare, getKeyShareFromStoredShare, type KeyShareInfo } from "../lib/keystore";
import { authenticatePasskey, sensitiveHeaders } from "../lib/passkey";
import { encryptKeyFile, decryptKeyFile, type KeyFileData } from "../lib/crypto";
import { PassphraseInput } from "./PassphraseInput";
import { authHeaders } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { useFrozen } from "../context/FrozenContext";
import { Spinner, ErrorBox } from "./ui";

// Extend window for temporary server export data (temp storage during server key download)
declare global {
  interface Window { __serverExportData?: KeyFileData; }
}

interface ServerKey {
  id: string;
  name: string | null;
  selfCustodyAt: string | null;
  hkdfDownloadedAt: string | null;
  hasClientBackup: boolean;
}

export function KeyShareManager() {
  const frozen = useFrozen();
  const [shares, setShares] = useState<KeyShareInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteChecked, setConfirmDeleteChecked] = useState(false);
  const [error, setError] = useState("");

  // Server share export state
  const [serverKeys, setServerKeys] = useState<ServerKey[]>([]);
  const [serverExportId, setServerExportId] = useState<string | null>(null);
  const [serverExportStep, setServerExportStep] = useState<"idle" | "loading" | "passphrase" | "done" | "error">("idle");
  const [serverExportError, setServerExportError] = useState("");

  // Import state
  const [importStep, setImportStep] = useState<"idle" | "decrypt" | "saving" | "encrypt">("idle");
  const [importData, setImportData] = useState<KeyFileData | null>(null);
  const [importPassphrase, setImportPassphrase] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Badge explanation
  const [badgeExplain, setBadgeExplain] = useState<string | null>(null);

  // Download choice dialog
  const [downloadChoiceId, setDownloadChoiceId] = useState<string | null>(null);
  const [hkdfDownloading, setHkdfDownloading] = useState(false);

  // Restore from escrow state
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restoreStep, setRestoreStep] = useState<"idle" | "loading" | "decrypt" | "encrypt" | "saving">("idle");
  const [restoreData, setRestoreData] = useState<KeyFileData | null>(null);

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (downloadChoiceId) { setDownloadChoiceId(null); return; }
      if (confirmDeleteId) { setConfirmDeleteId(null); return; }
      if (serverExportStep === "passphrase") { setServerExportStep("idle"); setServerExportId(null); delete window.__serverExportData; return; }
      if (importStep === "decrypt" || importStep === "encrypt") { setImportStep("idle"); setImportData(null); setImportPassphrase(null); return; }
      if (restoreStep === "decrypt" || restoreStep === "encrypt") { setRestoreStep("idle"); setRestoreId(null); setRestoreData(null); return; }
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDeleteId, serverExportStep, importStep, restoreStep]);

  useEffect(() => {
    setShares(listKeyShares());
    setLoading(false);

    // Fetch server keys for export section
    fetch(apiUrl("/api/keys"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        const keys = (d.keys || []) as Array<Record<string, unknown>>;
        setServerKeys(keys.map((k) => ({
          id: k.id as string,
          name: k.name as string | null,
          selfCustodyAt: k.selfCustodyAt as string | null,
          hkdfDownloadedAt: k.hkdfDownloadedAt as string | null,
          hasClientBackup: !!k.hasClientBackup,
        })));
      })
      .catch(() => {});
  }, []);

  function confirmDelete(keyId: string) {
    setConfirmDeleteId(keyId);
    setConfirmDeleteChecked(false);
  }

  async function handleDelete() {
    if (!confirmDeleteId) return;
    setDeletingId(confirmDeleteId);
    try {
      deleteKeyShare(confirmDeleteId);
      setShares((prev) => prev.filter((s) => s.keyId !== confirmDeleteId));
    } catch (err) {
      setError(String(err));
    }
    setDeletingId(null);
    setConfirmDeleteId(null);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setError("");
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as KeyFileData;
        if (!parsed.id || !parsed.share || !parsed.publicKey) {
          setError("Invalid key share file");
          return;
        }
        if (hasKeyShare(parsed.id)) {
          setError("This key share is already stored in the browser");
          return;
        }
        if (parsed.encrypted) {
          // Need passphrase to decrypt first
          setImportData(parsed);
          setImportStep("decrypt");
        } else {
          // Unencrypted — go straight to saving
          setImportData(parsed);
          setImportStep("encrypt");
        }
      } catch {
        setError("Could not parse key share file");
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be re-selected
    e.target.value = "";
  }

  async function handleImportDecrypt(passphrase: string) {
    if (!importData) return;
    try {
      const decrypted = await decryptKeyFile(importData, passphrase);
      setImportData(decrypted);
      setImportPassphrase(passphrase);
      setImportStep("encrypt");
    } catch {
      setError("Incorrect passphrase");
    }
  }

  async function saveImportWithPrf() {
    if (!importData) return;
    setImportStep("saving");
    try {
      const result = await authenticatePasskey({ withPrf: true });
      if (result.prfKey) {
        await saveKeyShareWithPrf(importData.id, importData, result.prfKey, result.credentialId!);
      } else {
        // PRF not supported — fall back to passphrase
        setImportStep("encrypt");
        return;
      }
      setImportData(null);
      setImportPassphrase(null);
      setImportStep("idle");
      setShares(listKeyShares());
    } catch (err) {
      setError(String(err));
      setImportStep("encrypt");
    }
  }

  async function saveImportWithPassphrase(passphrase: string) {
    if (!importData) return;
    setImportStep("saving");
    try {
      await saveKeyShareWithPassphrase(importData.id, importData, passphrase);
      setImportData(null);
      setImportPassphrase(null);
      setImportStep("idle");
      setShares(listKeyShares());
    } catch (err) {
      setError(String(err));
      setImportStep("encrypt");
    }
  }

  async function handleRestoreFromEscrow(keyId: string) {
    setRestoreId(keyId);
    setRestoreStep("loading");
    setError("");
    try {
      await authenticatePasskey({});
      const headers = sensitiveHeaders();
      const res = await fetch(apiUrl(`/api/keys/${keyId}/backup`), { headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to download backup");
        setRestoreStep("idle");
        setRestoreId(null);
        return;
      }
      const { encryptedData } = await res.json();
      const parsed = JSON.parse(encryptedData);

      // Detect StoredShare format (PRF-encrypted browser backup from auto-escrow)
      if (parsed.mode === "prf" && parsed.ciphertext) {
        const prfAuth = await authenticatePasskey({ withPrf: true });
        if (!prfAuth.prfKey) {
          setError("Passkey PRF not supported — cannot decrypt this backup");
          setRestoreStep("idle");
          setRestoreId(null);
          return;
        }
        const decrypted = await getKeyShareFromStoredShare(parsed, prfAuth.prfKey);
        if (!decrypted) {
          setError("Failed to decrypt backup — passkey may not match");
          setRestoreStep("idle");
          setRestoreId(null);
          return;
        }
        setRestoreData(decrypted);
        setRestoreStep("encrypt");
      } else if ((parsed as KeyFileData).encrypted) {
        setRestoreData(parsed as KeyFileData);
        setRestoreStep("decrypt");
      } else {
        setRestoreData(parsed as KeyFileData);
        setRestoreStep("encrypt");
      }
    } catch (err) {
      setError(String(err));
      setRestoreStep("idle");
      setRestoreId(null);
    }
  }

  async function handleRestoreDecrypt(passphrase: string) {
    if (!restoreData) return;
    try {
      const decrypted = await decryptKeyFile(restoreData, passphrase);
      setRestoreData(decrypted);
      setRestoreStep("encrypt");
    } catch {
      setError("Incorrect passphrase");
    }
  }

  async function saveRestoreWithPrf() {
    if (!restoreData) return;
    setRestoreStep("saving");
    try {
      const result = await authenticatePasskey({ withPrf: true });
      if (result.prfKey) {
        await saveKeyShareWithPrf(restoreData.id, restoreData, result.prfKey, result.credentialId!);
      } else {
        setRestoreStep("encrypt");
        return;
      }
      setRestoreData(null);
      setRestoreStep("idle");
      setRestoreId(null);
      setShares(listKeyShares());
    } catch (err) {
      setError(String(err));
      setRestoreStep("encrypt");
    }
  }

  async function saveRestoreWithPassphrase(passphrase: string) {
    if (!restoreData) return;
    setRestoreStep("saving");
    try {
      await saveKeyShareWithPassphrase(restoreData.id, restoreData, passphrase);
      setRestoreData(null);
      setRestoreStep("idle");
      setRestoreId(null);
      setShares(listKeyShares());
    } catch (err) {
      setError(String(err));
      setRestoreStep("encrypt");
    }
  }

  async function handleHkdfDownload(keyId: string) {
    setHkdfDownloading(true);
    setServerExportError("");
    try {
      await authenticatePasskey({});
      const headers = sensitiveHeaders();
      const res = await fetch(apiUrl(`/api/keys/${keyId}/backup/server-share-hkdf`), { headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setServerExportError(data.error || "Download failed");
        setHkdfDownloading(false);
        return;
      }
      const { encryptedShare, encryptedEddsaShare, publicKey, eddsaPublicKey } = await res.json();
      const payload = JSON.stringify({ id: keyId, peer: 2, share: encryptedShare, eddsaShare: encryptedEddsaShare || "", publicKey: publicKey || "", eddsaPublicKey: eddsaPublicKey || "", encryption: "server-hkdf" }, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const serverName = serverKeys.find((k) => k.id === keyId)?.name;
      const safeName = serverName ? serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-") : keyId.slice(0, 8);
      a.download = `kexify-server-hkdf-${safeName}-${keyId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      // Refresh server keys to pick up hkdfDownloadedAt
      fetch(apiUrl("/api/keys"), { headers: authHeaders() })
        .then((r) => r.json())
        .then((d) => {
          const keys = (d.keys || []) as Array<Record<string, unknown>>;
          setServerKeys(keys.map((k) => ({
            id: k.id as string,
            name: k.name as string | null,
            selfCustodyAt: k.selfCustodyAt as string | null,
            hkdfDownloadedAt: k.hkdfDownloadedAt as string | null,
            hasClientBackup: !!k.hasClientBackup,
          })));
        })
        .catch(() => {});

      setDownloadChoiceId(null);
    } catch (err) {
      setServerExportError(String(err));
    }
    setHkdfDownloading(false);
  }

  async function handleServerExport(keyId: string) {
    setServerExportId(keyId);
    setServerExportStep("loading");
    setServerExportError("");
    try {
      await authenticatePasskey({});

      const ephKey = crypto.getRandomValues(new Uint8Array(32));
      const ephKeyBase64 = btoa(String.fromCharCode(...ephKey));

      const headers = sensitiveHeaders();
      const res = await fetch(apiUrl(`/api/keys/${keyId}/backup/server-share`), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ephemeralKey: ephKeyBase64 }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setServerExportError(data.error || "Export failed");
        setServerExportStep("error");
        return;
      }

      const { encryptedShare, encryptedEddsaShare, publicKey, eddsaPublicKey } = await res.json();

      const cryptoKey = await crypto.subtle.importKey("raw", ephKey, "AES-GCM", false, ["decrypt"]);

      async function ephDecrypt(encB64: string): Promise<string> {
        const combined = Uint8Array.from(atob(encB64), (c) => c.charCodeAt(0));
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
        return new TextDecoder().decode(plain);
      }

      const plainShare = await ephDecrypt(encryptedShare);
      const plainEddsaShare = encryptedEddsaShare ? await ephDecrypt(encryptedEddsaShare) : "";

      window.__serverExportData = {
        id: keyId,
        peer: 2,
        share: plainShare,
        publicKey,
        eddsaShare: plainEddsaShare,
        eddsaPublicKey,
      } as KeyFileData;

      setServerExportStep("passphrase");
    } catch (err) {
      setServerExportError(String(err));
      setServerExportStep("error");
    }
  }

  async function downloadServerExport(passphrase: string) {
    const data = window.__serverExportData as KeyFileData;
    if (!data) return;
    const encrypted = await encryptKeyFile(data, passphrase);
    const blob = new Blob([JSON.stringify(encrypted, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const serverName = serverKeys.find((k) => k.id === data.id)?.name;
    const safeServerName = serverName ? serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-") : data.id.slice(0, 8);
    a.download = `kexify-server-${safeServerName}-${data.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    delete window.__serverExportData;
    setServerExportStep("done");

    fetch(apiUrl("/api/keys"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        const keys = (d.keys || []) as Array<Record<string, unknown>>;
        setServerKeys(keys.map((k) => ({
          id: k.id as string,
          name: k.name as string | null,
          selfCustodyAt: k.selfCustodyAt as string | null,
          hkdfDownloadedAt: k.hkdfDownloadedAt as string | null,
          hasClientBackup: !!k.hasClientBackup,
        })));
      })
      .catch(() => {});
  }

  return (
    <div className="space-y-5">
      <div className="pt-2 pb-2">
        <h2 className="text-lg font-semibold text-text-primary">Browser Storage</h2>
        <p className="text-[11px] text-text-muted mt-2 leading-relaxed">
          Your client key share (1 of 2) is encrypted and stored in this browser only. It never leaves your device.
        </p>
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 mt-2">
          <p className="text-[11px] text-yellow-500">
            Lost access? Restore from a backup file or server escrow.
          </p>
        </div>
      </div>

      {/* Import section */}
      <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileSelect} />

      <label
        onClick={() => fileInputRef.current?.click()}
        className="flex items-center justify-center gap-2 w-full bg-surface-secondary border border-border-primary border-dashed rounded-lg px-3 py-4 text-xs text-text-muted hover:border-blue-500/50 hover:text-text-secondary transition-colors cursor-pointer"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        Choose key share file (.json)
      </label>

      {error && <ErrorBox>{error}</ErrorBox>}

      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      ) : shares.length === 0 ? (
        <div className="text-center py-12">
          <div className="w-12 h-12 rounded-full bg-surface-tertiary flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
          </div>
          <p className="text-sm text-text-secondary">No key shares stored in this browser</p>
          <p className="text-[11px] text-text-muted mt-1">Save a key share during account creation or import one here.</p>
        </div>
      ) : (
        <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
          {[...shares].sort((a, b) => {
            const nameA = serverKeys.find((k) => k.id === a.keyId)?.name || a.keyId;
            const nameB = serverKeys.find((k) => k.id === b.keyId)?.name || b.keyId;
            return nameA.localeCompare(nameB);
          }).map((s) => (
            <div key={s.keyId} className="flex items-center h-[68px] px-3 md:px-5 group">
              <div className="w-9 h-9 rounded-full bg-surface-tertiary flex items-center justify-center shrink-0 mr-3">
                <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 11-18 0V5.25" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-text-secondary truncate">{serverKeys.find((k) => k.id === s.keyId)?.name || s.keyId.slice(0, 8) + "..." + s.keyId.slice(-4)}</p>
                <p className="text-[10px] text-text-muted mt-0.5">{s.mode === "prf" ? "Passkey encrypted" : "Passphrase encrypted"} · {new Date(s.storedAt).toLocaleDateString()}</p>
              </div>
              <button
                onClick={() => confirmDelete(s.keyId)}
                disabled={deletingId === s.keyId}
                className="p-1.5 rounded-md text-text-muted hover:text-red-400 hover:bg-surface-tertiary transition-colors md:opacity-0 md:group-hover:opacity-100 disabled:opacity-50 shrink-0"
                title="Remove from browser"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Restore from server escrow — accounts with backup but no local share */}
      {(() => {
        const localKeyIds = new Set(shares.map((s) => s.keyId));
        const restorable = serverKeys.filter((k) => k.hasClientBackup && !localKeyIds.has(k.id));
        if (restorable.length === 0) return null;
        return (
          <>
            <div className="pt-4 border-t border-border-primary">
              <h2 className="text-lg font-semibold text-text-primary">Server Backup</h2>
              <p className="text-[11px] text-text-muted mt-2 leading-relaxed">
                An encrypted copy of your client key share is stored on the server as a recovery backup. The server cannot read it — only you can decrypt it with your passphrase.
              </p>
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 mt-2">
                <p className="text-[11px] text-yellow-500">
                  Download it to restore signing access if you lose this browser's storage.
                </p>
              </div>
            </div>
            <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
              {restorable.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map((k) => (
                <div key={k.id}>
                  <div className="flex items-center h-[68px] px-3 md:px-5">
                    <div className="w-9 h-9 rounded-full bg-surface-tertiary flex items-center justify-center shrink-0 mr-3">
                      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-text-secondary truncate">{k.name || `Key ${k.id.slice(0, 8)}`}</p>
                      <p className="text-[10px] text-text-muted mt-0.5">Backup available on server</p>
                    </div>
                    <button
                      onClick={() => handleRestoreFromEscrow(k.id)}
                      disabled={(restoreId === k.id && restoreStep === "loading") || frozen}
                      className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors disabled:opacity-50 shrink-0"
                    >
                      {restoreId === k.id && restoreStep === "loading" ? "..." : "📥 Download"}
                    </button>
                  </div>

                  {/* Saving spinner */}
                  {restoreId === k.id && restoreStep === "saving" && (
                    <div className="px-3 md:px-5 pb-3 flex items-center gap-2">
                      <Spinner size="sm" />
                      <span className="text-xs text-text-muted">Saving...</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        );
      })()}

      {/* Server Key Share */}
      {serverKeys.length > 0 && (
        <>
          <div className="pt-4 border-t border-border-primary">
            <h2 className="text-lg font-semibold text-text-primary">Server Key Share</h2>
            <p className="text-[11px] text-text-muted mt-2 leading-relaxed">
              The server holds its key share (2 of 2) to co-sign transactions. Under normal operation, you do not need to download it.
            </p>
            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 mt-2">
              <p className="text-[11px] text-yellow-500">
                Only download this if you need to recover your wallet without our service. Holding both shares removes the security benefit of two-party signing.
              </p>
            </div>
          </div>

          <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
            {[...serverKeys].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)).map((k) => (
              <div key={k.id}>
                <div className="flex items-center h-[68px] px-3 md:px-5">
                  <div className="w-9 h-9 rounded-full bg-surface-tertiary flex items-center justify-center shrink-0 mr-3">
                    <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-secondary truncate">
                      {k.name || `Key ${k.id.slice(0, 8)}`}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {k.selfCustodyAt && (
                        <button
                          onClick={() => setBadgeExplain(badgeExplain === `sc-${k.id}` ? null : `sc-${k.id}`)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
                        >
                          Self-custody
                        </button>
                      )}
                      {k.hkdfDownloadedAt && !k.selfCustodyAt && (
                        <button
                          onClick={() => setBadgeExplain(badgeExplain === `hkdf-${k.id}` ? null : `hkdf-${k.id}`)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors"
                        >
                          Server backup
                        </button>
                      )}
                      {k.hasClientBackup && (
                        <button
                          onClick={() => setBadgeExplain(badgeExplain === `bu-${k.id}` ? null : `bu-${k.id}`)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors"
                        >
                          Key escrowed
                        </button>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => setDownloadChoiceId(k.id)}
                    disabled={(serverExportId === k.id && serverExportStep === "loading") || frozen}
                    className="px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors disabled:opacity-50 shrink-0"
                  >
                    {serverExportId === k.id && serverExportStep === "loading" ? "..." : "📥 Download"}
                  </button>
                </div>

                {/* Badge explanations */}
                {badgeExplain === `sc-${k.id}` && (
                  <p className="px-3 md:px-5 pb-3 text-[10px] text-purple-400/80 leading-relaxed">
                    You hold both key shares and can recover your wallet without our server.
                  </p>
                )}
                {badgeExplain === `hkdf-${k.id}` && (
                  <p className="px-3 md:px-5 pb-3 text-[10px] text-blue-400/80 leading-relaxed">
                    You downloaded a copy of the server's key. It's encrypted — contact kexify support to decrypt it in an emergency.
                  </p>
                )}
                {badgeExplain === `bu-${k.id}` && (
                  <p className="px-3 md:px-5 pb-3 text-[10px] text-green-400/80 leading-relaxed">
                    Your client key is escrowed on our server. Restore it on any device using your passphrase.
                  </p>
                )}

                {serverExportId === k.id && serverExportStep === "done" && (
                  <div className="px-3 md:px-5 pb-3 flex items-center gap-2">
                    <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    <p className="text-xs text-green-400">Server share exported. Store it safely.</p>
                  </div>
                )}

                {serverExportId === k.id && serverExportStep === "error" && (
                  <div className="px-3 md:px-5 pb-3">
                    <p className="text-xs text-red-400">{serverExportError}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {/* Download choice dialog */}
      {downloadChoiceId && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDownloadChoiceId(null)} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">📥 Download Server Key</h3>
              <button onClick={() => setDownloadChoiceId(null)} className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-3">
              <p className="text-xs text-text-secondary leading-relaxed">
                Choose how you want to download the server's key share.
              </p>

              {/* Option 1: HKDF backup */}
              <button
                onClick={() => handleHkdfDownload(downloadChoiceId)}
                disabled={hkdfDownloading}
                className="w-full text-left bg-surface-primary border border-border-primary hover:border-blue-500/30 rounded-lg px-4 py-3.5 transition-colors group disabled:opacity-50"
              >
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
                    <svg className="w-4 h-4 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-text-primary group-hover:text-blue-400 transition-colors">
                      {hkdfDownloading ? "Downloading..." : "Safe backup (recommended)"}
                    </p>
                    <p className="text-[10px] text-text-muted mt-0.5 leading-relaxed">
                      Encrypted by the server. You keep a backup copy, but cannot decrypt it on your own. In an emergency, contact kexify support to get the decryption key.
                    </p>
                  </div>
                </div>
              </button>

              {/* Option 2: Self-custody */}
              <button
                onClick={() => { setDownloadChoiceId(null); handleServerExport(downloadChoiceId); }}
                className="w-full text-left bg-surface-primary border border-border-primary hover:border-border-secondary rounded-lg px-4 py-3.5 transition-colors group"
              >
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-full bg-surface-tertiary flex items-center justify-center shrink-0 mt-0.5">
                    <svg className="w-4 h-4 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-text-primary group-hover:text-text-secondary transition-colors">Full self-custody</p>
                    <p className="text-[10px] text-text-muted mt-0.5 leading-relaxed">
                      Decrypted and re-encrypted with your passphrase. You hold both key shares and no longer depend on us. Use this only if you understand the security implications.
                    </p>
                  </div>
                </div>
              </button>

              {serverExportError && <ErrorBox>{serverExportError}</ErrorBox>}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete confirmation dialog */}
      {confirmDeleteId && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setConfirmDeleteId(null)} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">🗑️ Remove from Browser</h3>
              <button onClick={() => setConfirmDeleteId(null)} className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-4">
              {!serverKeys.find((k) => k.id === confirmDeleteId)?.hasClientBackup && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 flex items-start gap-2">
                  <svg className="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <p className="text-xs text-red-400 leading-relaxed">
                    This key share is not backed up on the server. Removing it without a backup file means you will permanently lose access to this account.
                  </p>
                </div>
              )}
              <p className="text-xs text-text-secondary leading-relaxed">
                <span className="font-medium text-text-primary">{serverKeys.find((k) => k.id === confirmDeleteId)?.name || confirmDeleteId.slice(0, 8) + "..."}</span> will be removed from this browser. You can re-import it later from a backup file or server backup.
              </p>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmDeleteChecked}
                  onChange={(e) => setConfirmDeleteChecked(e.target.checked)}
                  className="mt-0.5 shrink-0 accent-blue-500"
                />
                <span className="text-xs text-text-secondary leading-relaxed">I have a backup file or server backup enabled for this key</span>
              </label>
            </div>
            <div className="px-5 py-4 border-t border-border-primary flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-2.5 rounded-lg text-sm font-medium bg-surface-tertiary text-text-secondary hover:bg-border-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={!confirmDeleteChecked}
                className="px-4 py-2.5 rounded-lg text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:bg-surface-tertiary disabled:text-text-muted disabled:cursor-not-allowed"
              >
                🗑️ Delete
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Restore from escrow dialogs */}
      {/* Server share export passphrase dialog */}
      {serverExportStep === "passphrase" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => { setServerExportStep("idle"); setServerExportId(null); delete window.__serverExportData; }} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">📥 Download Server Key</h3>
              <button onClick={() => { setServerExportStep("idle"); setServerExportId(null); delete window.__serverExportData; }} className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-3">
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2.5">
                <p className="text-xs text-yellow-400 leading-relaxed">
                  Choose a passphrase to encrypt this file. You will need it to use the file later. There is no way to recover a forgotten passphrase.
                </p>
              </div>
              <PassphraseInput
                mode="set"
                hideHint
                submitLabel="📥 Encrypt & Download"
                onSubmit={downloadServerExport}
              />
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Restore decrypt passphrase dialog */}
      {restoreStep === "decrypt" && restoreData && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => { setRestoreStep("idle"); setRestoreId(null); setRestoreData(null); }} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">🔓 Decrypt Backup</h3>
              <button onClick={() => { setRestoreStep("idle"); setRestoreId(null); setRestoreData(null); }} className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-3">
              <p className="text-xs text-text-muted leading-relaxed">
                Enter the passphrase you chose when this key was created.
              </p>
              <PassphraseInput
                mode="enter"
                submitLabel="🔓 Decrypt"
                onSubmit={handleRestoreDecrypt}
              />
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Restore choose storage method dialog */}
      {restoreStep === "encrypt" && restoreData && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => { setRestoreStep("idle"); setRestoreId(null); setRestoreData(null); }} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">🔐 Save Key Share</h3>
              <button onClick={() => { setRestoreStep("idle"); setRestoreId(null); setRestoreData(null); }} className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-3">
              <p className="text-xs text-text-muted leading-relaxed">
                Key share <span className="font-mono">{restoreData.id.slice(0, 8)}...</span> decrypted. Choose how to protect it in this browser.
              </p>
              <button
                onClick={saveRestoreWithPrf}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                🔑 Save with Passkey (PRF)
              </button>
              <p className="text-[10px] text-text-muted text-center">or encrypt with a passphrase:</p>
              <PassphraseInput
                mode="set"
                submitLabel="🔐 Save with Passphrase"
                onSubmit={saveRestoreWithPassphrase}
              />
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Import decrypt passphrase dialog */}
      {importStep === "decrypt" && importData && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => { setImportStep("idle"); setImportData(null); setImportPassphrase(null); }} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">🔓 Decrypt Key File</h3>
              <button onClick={() => { setImportStep("idle"); setImportData(null); setImportPassphrase(null); }} className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-3">
              <p className="text-xs text-text-muted leading-relaxed">
                Enter the passphrase you used to encrypt this file.
              </p>
              <PassphraseInput
                mode="enter"
                submitLabel="🔓 Decrypt"
                onSubmit={handleImportDecrypt}
              />
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Import choose storage method dialog */}
      {importStep === "encrypt" && importData && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => { setImportStep("idle"); setImportData(null); setImportPassphrase(null); }} />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-4 border-b border-border-primary flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">🔐 Save Key Share</h3>
              <button onClick={() => { setImportStep("idle"); setImportData(null); setImportPassphrase(null); }} className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-tertiary transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-5 space-y-3">
              <p className="text-xs text-text-muted leading-relaxed">
                Key share <span className="font-mono">{importData.id.slice(0, 8)}...</span> decrypted. Choose how to protect it in this browser.
              </p>
              <button
                onClick={saveImportWithPrf}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                🔑 Save with Passkey (PRF)
              </button>
              {importPassphrase ? (
                <>
                  <p className="text-[10px] text-text-muted text-center">or save with passphrase:</p>
                  <button
                    onClick={() => saveImportWithPassphrase(importPassphrase)}
                    className="w-full bg-surface-tertiary text-text-secondary hover:bg-border-primary px-4 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    🔐 Keep Current Passphrase
                  </button>
                  <p className="text-[10px] text-text-muted text-center">or set a new one:</p>
                  <PassphraseInput
                    mode="set"
                    submitLabel="🔐 Save with New Passphrase"
                    onSubmit={saveImportWithPassphrase}
                  />
                </>
              ) : (
                <>
                  <p className="text-[10px] text-text-muted text-center">or encrypt with a passphrase:</p>
                  <PassphraseInput
                    mode="set"
                    submitLabel="🔐 Save with Passphrase"
                    onSubmit={saveImportWithPassphrase}
                  />
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
      {/* Import saving spinner dialog */}
      {importStep === "saving" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-md shadow-xl">
            <div className="px-5 py-8 flex items-center justify-center gap-3">
              <Spinner size="sm" />
              <span className="text-sm text-text-secondary">Saving key share...</span>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
