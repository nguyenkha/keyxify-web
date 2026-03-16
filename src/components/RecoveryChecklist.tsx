import { useState, useEffect } from "react";
import { authHeaders } from "../lib/auth";
import { apiUrl } from "../lib/apiBase";
import { listKeyShares, hasKeyShare } from "../lib/keystore";

interface AccountStatus {
  id: string;
  name: string | null;
  hasClientBackup: boolean;
  hkdfDownloadedAt: string | null;
  selfCustodyAt: string | null;
  hasBrowserShare: boolean;
}

export function RecoveryChecklist() {
  const [accounts, setAccounts] = useState<AccountStatus[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const browserShares = listKeyShares();
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
  }, []);

  if (loading) {
    return (
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-text-primary">Backup & Recovery</h2>
        <div className="text-xs text-text-muted text-center py-8">Loading...</div>
      </div>
    );
  }

  const allBrowserShares = accounts.every((a) => a.hasBrowserShare);
  const allBackedUp = accounts.every((a) => a.hasClientBackup);
  const allServerExported = accounts.every((a) => a.hkdfDownloadedAt || a.selfCustodyAt);
  const overallReady = allBrowserShares && allBackedUp && allServerExported;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Backup & Recovery</h2>
        <p className="text-xs text-text-muted mt-1">
          Keep your wallet safe. Complete these steps so you can recover your accounts if needed.
        </p>
      </div>

      {/* Overall status */}
      {overallReady ? (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-3">
          <p className="text-xs text-green-400 font-medium">All set! Your wallet is fully backed up.</p>
          <p className="text-[11px] text-green-400/70 mt-1">
            You can recover all your accounts even if you lose access to this device or our server goes down.
          </p>
        </div>
      ) : (
        <div className="bg-yellow-500/5 border border-yellow-500/15 rounded-lg px-4 py-3">
          <p className="text-xs text-yellow-500 font-medium">Some backup steps are incomplete</p>
          <p className="text-[11px] text-yellow-500/70 mt-1">
            Complete the checklist below to ensure you can always recover your wallet.
          </p>
        </div>
      )}

      {/* Per-account checklist */}
      {accounts.map((account) => {
        const steps = [
          {
            label: "Key saved in this browser",
            detail: "Your key is encrypted and stored locally so you can sign transactions.",
            done: account.hasBrowserShare,
          },
          {
            label: "Key backed up on server",
            detail: "An encrypted copy of your key is stored on our server. You can restore it on any device.",
            done: account.hasClientBackup,
          },
          {
            label: "Server key downloaded",
            detail: "You have a copy of the server's key share. Combined with yours, it lets you recover without our server.",
            done: !!(account.hkdfDownloadedAt || account.selfCustodyAt),
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
            <div className="bg-surface-secondary rounded-xl border border-border-primary overflow-hidden divide-y divide-border-secondary">
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
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Recovery guide */}
      <div>
        <p className="text-[10px] text-text-muted uppercase tracking-wider font-semibold mb-2 px-1">
          How to recover
        </p>
        <div className="bg-surface-secondary rounded-xl border border-border-primary overflow-hidden divide-y divide-border-secondary">
          <div className="px-3 md:px-5 py-3 flex items-start gap-3">
            <span className="text-sm shrink-0 mt-0.5">1</span>
            <div>
              <p className="text-xs font-medium text-text-primary">Get both key files</p>
              <p className="text-[10px] text-text-muted mt-0.5 leading-relaxed">
                You need your key file and the server key file. Both should be saved as .json files.
              </p>
            </div>
          </div>
          <div className="px-3 md:px-5 py-3 flex items-start gap-3">
            <span className="text-sm shrink-0 mt-0.5">2</span>
            <div>
              <p className="text-xs font-medium text-text-primary">Open the recovery page</p>
              <p className="text-[10px] text-text-muted mt-0.5 leading-relaxed">
                Go to{" "}
                <a
                  href={`${window.location.origin}/recovery`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300"
                >
                  {window.location.origin}/recovery
                </a>
                {" "}and load both files. The app works offline — no server needed.
              </p>
            </div>
          </div>
          <div className="px-3 md:px-5 py-3 flex items-start gap-3">
            <span className="text-sm shrink-0 mt-0.5">3</span>
            <div>
              <p className="text-xs font-medium text-text-primary">Move your funds</p>
              <p className="text-[10px] text-text-muted mt-0.5 leading-relaxed">
                Once in recovery mode, send your funds to a new wallet for best security.
                You can also use WalletConnect to interact with any dApp.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Recovery URL for saving */}
      <div className="bg-surface-primary border border-border-primary rounded-lg px-3 py-2.5">
        <p className="text-[10px] text-text-muted mb-1">Save this URL for emergencies:</p>
        <p className="text-xs font-mono text-text-secondary break-all">{window.location.origin}/recovery</p>
      </div>
    </div>
  );
}
