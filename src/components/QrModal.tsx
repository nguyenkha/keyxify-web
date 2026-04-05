import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Chain, Asset } from "../lib/api";
import { QRCodeSVG } from "qrcode.react";
import { Smartphone } from "lucide-react";

export function QrModal({ address, asset, chain, onClose }: { address: string; asset: Asset; chain: Chain; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  function copyAddr() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-surface-secondary border border-border-primary rounded-2xl w-full max-w-xs shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-1.5"><Smartphone className="w-4 h-4" />{t("common.qrReceive")}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-tertiary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-5 flex flex-col items-center gap-4">
          <div className="bg-white rounded-xl p-4 relative">
            <QRCodeSVG value={address} size={200} level="M" />
            {(asset.iconUrl || chain.iconUrl) && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="bg-white rounded-full p-1">
                  <img
                    src={asset.iconUrl || chain.iconUrl!}
                    alt={asset.symbol}
                    className="w-8 h-8 rounded-full"
                  />
                </div>
              </div>
            )}
          </div>
          <button
            onClick={copyAddr}
            className="w-full max-w-[280px] rounded-lg bg-surface-primary/60 border border-border-secondary px-2 py-2 text-[10px] font-mono text-center hover:bg-surface-tertiary/50 transition-colors cursor-pointer truncate"
            title={t("common.copy")}
          >
            {copied ? <span className="text-green-500">{t("common.copied")}</span> : <span className="text-text-secondary">{address}</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
