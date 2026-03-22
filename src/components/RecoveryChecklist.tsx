import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { authHeaders, isStandaloneJwt, getIdentityId } from "../lib/auth";
import { sensitiveHeaders, authenticatePasskey } from "../lib/passkey";
import { Spinner } from "./ui";
import { apiUrl } from "../lib/apiBase";
import {
  listKeyShares,
  hasKeyShare,
  getKeyShareMode,
  getKeyShareWithPrf,
  getKeyShareWithPassphrase,
  saveKeyShareWithPrf,
  saveKeyShareWithPassphrase,
} from "../lib/keystore";
import { type KeyFileData, isEncryptedKeyFile, decryptKeyFile, encryptKeyFile } from "../lib/crypto";
import { PassphraseInput } from "./PassphraseInput";
import { RecoveryGuide } from "./RecoveryGuide";

interface AccountStatus {
  id: string;
  name: string | null;
  hasClientBackup: boolean;
  hkdfDownloadedAt: string | null;
  selfCustodyAt: string | null;
  hasBrowserShare: boolean;
}

export function RecoveryChecklist() {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<AccountStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [hkdfDownloadingId, setHkdfDownloadingId] = useState<string | null>(null);
  const [hkdfError, setHkdfError] = useState<string | null>(null);

  // Import flow state
  const [importAccountId, setImportAccountId] = useState<string | null>(null);
  const [importStep, setImportStep] = useState<"idle" | "decrypt" | "saving">("idle");
  const [importData, setImportData] = useState<KeyFileData | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Escrow upload state
  const [escrowAccountId, setEscrowAccountId] = useState<string | null>(null);
  const [escrowUploading, setEscrowUploading] = useState(false);
  const [escrowError, setEscrowError] = useState<string | null>(null);
  const escrowFileRef = useRef<HTMLInputElement>(null);

  // Download from browser state
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadPassphraseId, setDownloadPassphraseId] = useState<string | null>(null);
  // Holds decrypted data awaiting a passphrase to re-encrypt for download
  const [pendingDownloadData, setPendingDownloadData] = useState<{ data: KeyFileData; account: AccountStatus } | null>(null);

  function fetchAccounts() {
    const allShares = listKeyShares();
    // Filter to current identity only
    const identityId = getIdentityId();
    const browserShares = isStandaloneJwt()
      ? allShares.filter((s) => s.keyId === identityId)
      : allShares.filter((s) => s.type === "email");
    const browserIds = new Set(browserShares.map((s) => s.keyId));

    fetch(apiUrl("/api/keys"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        const keys = (d.keys || []) as Array<Record<string, unknown>>;
        setAccounts(keys.filter((k) => k.enabled).map((k) => ({
          id: k.id as string,
          name: k.name as string | null,
          hasClientBackup: !!k.hasClientBackup,
          hkdfDownloadedAt: k.hkdfDownloadedAt as string | null,
          selfCustodyAt: k.selfCustodyAt as string | null,
          hasBrowserShare: browserIds.has(k.id as string) || hasKeyShare(k.id as string),
        })));
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { fetchAccounts(); }, []);

  // ── HKDF download ──
  async function handleHkdfDownload(account: AccountStatus) {
    setHkdfDownloadingId(account.id);
    setHkdfError(null);
    try {
      await authenticatePasskey({});
      const headers = sensitiveHeaders();
      const res = await fetch(apiUrl(`/api/keys/${account.id}/backup/server-share-hkdf`), { headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setHkdfError(data.error || t("recovery.downloadFailed"));
        setHkdfDownloadingId(null);
        return;
      }
      const { encryptedShare, encryptedEddsaShare, publicKey, eddsaPublicKey } = await res.json();
      const payload = JSON.stringify({ id: account.id, peer: 2, share: encryptedShare, eddsaShare: encryptedEddsaShare || "", publicKey: publicKey || "", eddsaPublicKey: eddsaPublicKey || "", encryption: "server-hkdf" }, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = account.name ? account.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : account.id.slice(0, 8);
      a.download = `kexify-server-hkdf-${safeName}-${account.id.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      fetchAccounts();
    } catch (err) {
      setHkdfError(String(err));
    }
    setHkdfDownloadingId(null);
  }

  // ── Import key file to browser ──
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setImportError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as KeyFileData;
        if (!parsed.id || !parsed.share || !parsed.publicKey) {
          setImportError(t("recovery.invalidKeyShareFile"));
          return;
        }
        if (importAccountId && parsed.id !== importAccountId) {
          setImportError(t("recovery.keyFileDifferentAccount"));
          return;
        }
        if (isEncryptedKeyFile(parsed)) {
          setImportData(parsed);
          setImportStep("decrypt");
        } else {
          saveImport(parsed);
        }
      } catch {
        setImportError(t("recovery.couldNotParseKeyFile"));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function handleImportDecrypt(passphrase: string) {
    if (!importData) return;
    setImportError(null);
    try {
      const decrypted = await decryptKeyFile(importData, passphrase);
      await saveImport(decrypted);
    } catch {
      setImportError(t("recovery.incorrectPassphrase"));
    }
  }

  async function saveImport(data: KeyFileData) {
    setImportStep("saving");
    try {
      const result = await authenticatePasskey({ withPrf: true });
      if (result.prfKey && result.credentialId) {
        await saveKeyShareWithPrf(data.id, data, result.prfKey, result.credentialId);
      } else {
        // PRF not supported — use the original passphrase or a default
        await saveKeyShareWithPassphrase(data.id, data, "");
      }
      setImportStep("idle");
      setImportData(null);
      setImportAccountId(null);
      fetchAccounts();
    } catch (err) {
      setImportError(String(err));
      setImportStep("idle");
    }
  }

  // ── Upload escrow backup ──
  function handleEscrowFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    setEscrowError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as KeyFileData;
        if (!parsed.id || !parsed.share || !parsed.publicKey) {
          setEscrowError(t("recovery.invalidKeyShareFile"));
          return;
        }
        if (escrowAccountId && parsed.id !== escrowAccountId) {
          setEscrowError(t("recovery.keyFileDifferentAccount"));
          return;
        }
        // Upload the file as-is (already encrypted with user's passphrase)
        uploadEscrow(parsed);
      } catch {
        setEscrowError(t("recovery.couldNotParseKeyFile"));
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  async function uploadEscrow(data: KeyFileData) {
    setEscrowUploading(true);
    setEscrowError(null);
    try {
      await authenticatePasskey({});
      const headers = sensitiveHeaders();
      const encryptedJson = JSON.stringify(data);
      const res = await fetch(apiUrl(`/api/keys/${data.id}/backup`), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          encryptedData: encryptedJson,
          publicKey: data.publicKey,
          eddsaPublicKey: data.eddsaPublicKey,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setEscrowError(d.error || t("recovery.uploadFailed"));
      } else {
        setEscrowAccountId(null);
        fetchAccounts();
      }
    } catch (err) {
      setEscrowError(String(err));
    }
    setEscrowUploading(false);
  }

  // ── Download key share from browser storage ──
  // Step 1: Decrypt from browser → hold in pendingDownloadData
  // Step 2: Ask user for a passphrase → encrypt & download
  async function handleDownloadFromBrowser(account: AccountStatus) {
    setDownloadingId(account.id);
    setDownloadError(null);
    setDownloadPassphraseId(null);
    setPendingDownloadData(null);
    try {
      const mode = getKeyShareMode(account.id);
      let data: KeyFileData | null = null;

      if (mode === "prf") {
        const result = await authenticatePasskey({ withPrf: true });
        if (result.prfKey) {
          data = await getKeyShareWithPrf(account.id, result.prfKey);
        }
        if (!data) { setDownloadError(t("recovery.couldNotDecryptWrongPasskey")); setDownloadingId(null); return; }
      } else if (mode === "passphrase") {
        // Need passphrase to decrypt browser share first
        setDownloadPassphraseId(account.id);
        setDownloadingId(null);
        return;
      } else {
        setDownloadError(t("recovery.noBrowserKeyShare")); setDownloadingId(null); return;
      }

      // Decrypted — now ask for a passphrase to encrypt the download
      setPendingDownloadData({ data, account });
      setDownloadingId(null);
    } catch (err) {
      setDownloadError(String(err));
      setDownloadingId(null);
    }
  }

  // Called when user enters passphrase to decrypt a passphrase-encrypted browser share
  async function handleDecryptBrowserShare(passphrase: string, account: AccountStatus) {
    setDownloadError(null);
    setDownloadingId(account.id);
    try {
      const data = await getKeyShareWithPassphrase(account.id, passphrase);
      if (!data) { setDownloadError(t("recovery.couldNotDecrypt")); setDownloadingId(null); return; }
      // Decrypted — now ask for a passphrase to encrypt the download
      setPendingDownloadData({ data, account });
      setDownloadPassphraseId(null);
    } catch (err) {
      setDownloadError(String(err));
    }
    setDownloadingId(null);
  }

  // Called when user sets a passphrase to encrypt the downloaded file
  async function handleEncryptAndDownload(passphrase: string) {
    if (!pendingDownloadData) return;
    const { data, account } = pendingDownloadData;
    const encrypted = await encryptKeyFile(data, passphrase);
    const json = JSON.stringify(encrypted, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = account.name ? account.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : account.id.slice(0, 8);
    a.download = `kexify-${safeName}-${account.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setPendingDownloadData(null);
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-text-primary">{t("recovery.title")}</h2>
        <div className="text-xs text-text-muted text-center py-8">{t("common.loading")}</div>
      </div>
    );
  }

  const standalone = isStandaloneJwt();
  const allBrowserShares = accounts.every((a) => a.hasBrowserShare);
  const allBackedUp = standalone || accounts.every((a) => a.hasClientBackup);
  const allServerExported = accounts.every((a) => a.hkdfDownloadedAt || a.selfCustodyAt);
  const overallReady = allBrowserShares && allBackedUp && allServerExported;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">{t("recovery.title")}</h2>
        <p className="text-xs text-text-muted mt-1">
          {t("recovery.description")}
        </p>
      </div>

      {/* Overall status */}
      {overallReady ? (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-3">
          <p className="text-xs text-green-400 font-medium">{t("recovery.allSet")}</p>
          <p className="text-[11px] text-green-400/70 mt-1">
            {t("recovery.allSetDesc")}
          </p>
        </div>
      ) : (
        <div className="bg-yellow-500/5 border border-yellow-500/15 rounded-lg px-4 py-3">
          <p className="text-xs text-yellow-500 font-medium">{t("recovery.someIncomplete")}</p>
          <p className="text-[11px] text-yellow-500/70 mt-1">
            {t("recovery.incompleteDesc")}
          </p>
        </div>
      )}

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileSelect} />
      <input ref={escrowFileRef} type="file" accept=".json" className="hidden" onChange={handleEscrowFileSelect} />

      {/* Per-account checklist */}
      {accounts.map((account) => {
        const serverKeyDone = !!(account.hkdfDownloadedAt || account.selfCustodyAt);

        const standalone = isStandaloneJwt();
        const steps = [
          {
            key: "browser",
            label: t("recovery.keySavedInBrowser"),
            detail: t("recovery.browserDetail"),
            done: account.hasBrowserShare,
          },
          // Escrow backup is useless for standalone — can't re-auth without the key share
          ...(!standalone ? [{
            key: "escrow",
            label: t("recovery.keyBackedUpOnServer"),
            detail: t("recovery.escrowDetail"),
            done: account.hasClientBackup,
          }] : []),
          {
            key: "server",
            label: t("recovery.serverKeyDownloaded"),
            detail: serverKeyDone
              ? account.selfCustodyAt
                ? t("recovery.serverDetailSelfCustody")
                : t("recovery.serverDetailHkdf")
              : t("recovery.serverDetailDownload"),
            done: serverKeyDone,
          },
        ];

        const completedCount = steps.filter((s) => s.done).length;
        const allDone = completedCount === steps.length;

        return (
          <div key={account.id}>
            <div className="flex items-center justify-between mb-2 px-1">
              <p className="text-xs font-medium text-text-primary">
                {account.name || `Account ${account.id.slice(0, 8)}`}
              </p>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                allDone ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-400"
              }`}>
                {completedCount}/{steps.length}
              </span>
            </div>
            <div className="bg-surface-secondary rounded-lg border border-border-primary overflow-hidden divide-y divide-border-secondary">
              {steps.map((step, i) => (
                <div key={i} className="px-3 md:px-5 py-3 flex items-start gap-3">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                    step.done ? "bg-green-500/10" : "bg-surface-tertiary"
                  }`}>
                    {step.done ? (
                      <svg className="w-3 h-3 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    ) : (
                      <div className="w-1.5 h-1.5 rounded-full bg-text-muted/30" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium ${step.done ? "text-text-secondary" : "text-text-primary"}`}>
                      {step.label}
                    </p>
                    <p className="text-[10px] text-text-muted mt-0.5 leading-relaxed">{step.detail}</p>

                    {/* Step 1: Download key file from browser (when saved) */}
                    {step.done && step.key === "browser" && (
                      <div className="mt-2 space-y-1.5">
                        {/* Phase A: Enter passphrase to decrypt passphrase-encrypted browser share */}
                        {downloadPassphraseId === account.id && !pendingDownloadData ? (
                          <div className="space-y-2">
                            <p className="text-[10px] text-text-muted">{t("recovery.enterPassphraseToUnlock")}</p>
                            <PassphraseInput
                              mode="enter"
                              submitLabel={t("recovery.unlock")}
                              onSubmit={(p) => handleDecryptBrowserShare(p, account)}
                            />
                            <button
                              onClick={() => { setDownloadPassphraseId(null); setDownloadError(null); }}
                              className="text-[10px] text-text-muted hover:text-text-tertiary"
                            >
                              {t("common.cancel")}
                            </button>
                          </div>
                        ) : pendingDownloadData?.account.id === account.id ? (
                          /* Phase B: Set a passphrase to encrypt the downloaded file */
                          <div className="space-y-2">
                            <p className="text-[10px] text-text-muted">{t("recovery.setPassphraseForDownload")}</p>
                            <PassphraseInput
                              mode="set"
                              submitLabel={t("recovery.encryptAndDownload")}
                              onSubmit={handleEncryptAndDownload}
                            />
                            <button
                              onClick={() => setPendingDownloadData(null)}
                              className="text-[10px] text-text-muted hover:text-text-tertiary"
                            >
                              {t("common.cancel")}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleDownloadFromBrowser(account)}
                            disabled={downloadingId === account.id}
                            className="px-3 py-2 rounded-lg text-xs font-medium bg-surface-tertiary hover:bg-border-primary text-text-secondary transition-colors disabled:opacity-50"
                          >
                            {downloadingId === account.id ? t("recovery.exporting") : t("recovery.downloadKeyFile")}
                          </button>
                        )}
                        {downloadError && downloadingId === null && !downloadPassphraseId && !pendingDownloadData && (
                          <p className="text-[10px] text-red-400">{downloadError}</p>
                        )}
                      </div>
                    )}

                    {/* Step 1: Import key file */}
                    {!step.done && step.key === "browser" && (
                      <div className="mt-2 space-y-1.5">
                        {importStep === "decrypt" && importAccountId === account.id ? (
                          <div className="space-y-2">
                            <p className="text-[10px] text-text-muted">{t("recovery.enterPassphraseToDecrypt")}</p>
                            <PassphraseInput
                              mode="enter"
                              submitLabel={t("recovery.decryptAndSave")}
                              onSubmit={handleImportDecrypt}
                            />
                          </div>
                        ) : importStep === "saving" && importAccountId === account.id ? (
                          <div className="flex items-center gap-2">
                            <Spinner size="xs" />
                            <span className="text-[10px] text-text-muted">{t("recovery.saving")}</span>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setImportAccountId(account.id); setImportError(null); fileInputRef.current?.click(); }}
                            className="px-3 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                          >
                            {t("recovery.importKeyFile")}
                          </button>
                        )}
                        {importError && importAccountId === account.id && (
                          <p className="text-[10px] text-red-400">{importError}</p>
                        )}
                        <p className="text-[10px] text-text-muted leading-relaxed">
                          {t("recovery.moreOptionsInExpertMode")}
                        </p>
                      </div>
                    )}

                    {/* Step 2: Upload escrow */}
                    {!step.done && step.key === "escrow" && (
                      <div className="mt-2 space-y-1.5">
                        <button
                          onClick={() => { setEscrowAccountId(account.id); setEscrowError(null); escrowFileRef.current?.click(); }}
                          disabled={escrowUploading}
                          className="px-3 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                        >
                          {escrowUploading && escrowAccountId === account.id ? t("recovery.uploading") : t("recovery.uploadKeyFileAsBackup")}
                        </button>
                        {escrowError && escrowAccountId === account.id && (
                          <p className="text-[10px] text-red-400">{escrowError}</p>
                        )}
                        <p className="text-[10px] text-text-muted leading-relaxed">
                          {t("recovery.moreOptionsInExpertMode")}
                        </p>
                      </div>
                    )}

                    {/* Step 3: Download server key */}
                    {!step.done && step.key === "server" && (
                      <div className="mt-2 space-y-1.5">
                        <button
                          onClick={() => handleHkdfDownload(account)}
                          disabled={hkdfDownloadingId === account.id}
                          className="px-3 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
                        >
                          {hkdfDownloadingId === account.id ? t("recovery.downloading") : t("recovery.downloadServerKeyBackup")}
                        </button>
                        {hkdfError && hkdfDownloadingId === null && (
                          <p className="text-[10px] text-red-400">{hkdfError}</p>
                        )}
                        <p className="text-[10px] text-text-muted leading-relaxed">
                          {t("recovery.fullSelfCustodyExpert")}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <RecoveryGuide />
    </div>
  );
}
