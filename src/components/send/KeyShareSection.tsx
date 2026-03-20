import { PassphraseInput } from "../PassphraseInput";
import { decryptKeyFile } from "../../lib/crypto";
import { getKeyShareWithPassphrase } from "../../lib/keystore";
import type { KeyFile } from "../sendTypes";
import type { KeyFileData } from "../../lib/crypto";

interface KeyShareSectionProps {
  recovery: boolean;
  keyFile: KeyFile | null;
  setKeyFile: (kf: KeyFile | null) => void;
  pendingEncrypted: KeyFileData | null;
  setPendingEncrypted: (d: KeyFileData | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  browserShareMode: "prf" | "passphrase" | null;
  setBrowserShareMode: (m: "prf" | "passphrase" | null) => void;
  browserShareLoading: boolean;
  browserShareError: string;
  showBrowserPassphrase: boolean;
  keyId: string;
  loadBrowserShare: () => void;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

export function KeyShareSection({
  recovery,
  keyFile,
  setKeyFile,
  pendingEncrypted,
  setPendingEncrypted,
  fileInputRef,
  browserShareMode,
  setBrowserShareMode,
  browserShareLoading,
  browserShareError,
  showBrowserPassphrase,
  keyId,
  loadBrowserShare,
  handleFileSelect,
  t,
}: KeyShareSectionProps) {
  return (
    <>
      <div>
        <label className="block text-xs text-text-muted mb-1.5">{t("send.keyShare")}</label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="hidden"
        />
        {keyFile ? (
          <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-green-500/10 flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-text-secondary truncate">
                {keyFile.id.slice(0, 8)}...{keyFile.id.slice(-4)}
              </p>
              <p className="text-[10px] text-text-muted font-mono truncate">{keyFile.publicKey.slice(0, 24)}...</p>
            </div>
            <button
              onClick={() => !recovery && setKeyFile(null)}
              disabled={recovery}
              className={`p-1 rounded-md transition-colors ${recovery ? "opacity-40 cursor-not-allowed" : "hover:bg-surface-tertiary"}`}
              title={recovery ? t("send.keyLoaded") : t("send.changeKey")}
            >
              <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </button>
          </div>
        ) : browserShareMode && !showBrowserPassphrase ? (
          <div className="space-y-2">
            <button
              onClick={loadBrowserShare}
              disabled={browserShareLoading}
              className="w-full bg-surface-primary border border-blue-500/30 rounded-lg px-3 py-2.5 flex items-center gap-2.5 hover:border-blue-500/50 transition-colors text-left disabled:opacity-50 animate-pulse"
            >
              <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 11-18 0V5.25" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-text-secondary truncate">{keyId.slice(0, 8)}...</p>
                <p className="text-[10px] text-text-muted">{browserShareMode === "prf" ? t("send.passkeyEncrypted") : t("send.passphraseEncrypted")} · ECDSA + EdDSA</p>
              </div>
              {browserShareLoading ? (
                <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
              ) : (
                <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
              )}
            </button>
            {browserShareError && (
              <p className="text-[11px] text-red-400 text-center">{browserShareError}</p>
            )}
            <button
              onClick={() => { setBrowserShareMode(null); }}
              className="w-full text-[11px] text-text-muted hover:text-text-tertiary transition-colors"
            >
              {t("send.orUploadFile")}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full bg-surface-primary border border-border-primary border-dashed rounded-lg px-3 py-3 flex items-center justify-center gap-2 hover:border-blue-500/50 transition-colors text-left"
            >
              <svg className="w-4 h-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <span className="text-xs text-text-muted">{t("send.uploadKeyShare")}</span>
            </button>
            <p className="text-[10px] text-text-muted text-center">
              {t("send.restoreFromBackup")}
            </p>
          </div>
        )}
      </div>

      {/* Passphrase prompt for encrypted files */}
      {pendingEncrypted && !keyFile && (
        <div className="bg-surface-primary border border-border-primary rounded-lg p-3">
          <p className="text-xs text-text-muted mb-2">
            <span className="font-mono text-text-tertiary">{pendingEncrypted.id.slice(0, 8)}...</span> — {t("send.enterPassphrase")}
          </p>
          <PassphraseInput
            mode="enter"
            submitLabel={t("send.decrypt")}
            onSubmit={async (passphrase) => {
              const decrypted = await decryptKeyFile(pendingEncrypted, passphrase);
              setKeyFile(decrypted as KeyFile);
              setPendingEncrypted(null);
            }}
          />
        </div>
      )}

      {/* Browser-stored share passphrase prompt */}
      {showBrowserPassphrase && !keyFile && (
        <div className="bg-surface-primary border border-border-primary rounded-lg p-3">
          <p className="text-xs text-text-muted mb-2">
            {t("send.enterPassphraseKey")}
          </p>
          <PassphraseInput
            mode="enter"
            submitLabel={t("send.decrypt")}
            onSubmit={async (passphrase) => {
              const data = await getKeyShareWithPassphrase(keyId, passphrase);
              if (data) {
                setKeyFile(data as KeyFile);
              }
            }}
          />
        </div>
      )}
    </>
  );
}
