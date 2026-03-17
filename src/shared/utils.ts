/** Convert base64-encoded bytes to hex string. */
export function base64ToHex(b64: string): string {
  const binary = atob(b64);
  return Array.from(binary, (c) =>
    c.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

/** Convert hex string to Uint8Array. Handles optional 0x prefix and odd-length input. */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length === 0) return new Uint8Array(0);
  const padded = h.length % 2 ? "0" + h : h;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Convert Uint8Array to hex string (no 0x prefix). */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build an explorer link, preserving any query params (e.g. ?cluster=devnet). */
export function explorerLink(explorerUrl: string, path: string): string {
  const idx = explorerUrl.indexOf("?");
  const base = idx === -1 ? explorerUrl : explorerUrl.slice(0, idx);
  const query = idx === -1 ? "" : explorerUrl.slice(idx);

  // Tronscan uses hash-based routing: /#/transaction/, /#/address/
  if (base.includes("tronscan.org")) {
    const mapped = path
      .replace(/^\/tx\//, "/#/transaction/")
      .replace(/^\/address\//, "/#/address/");
    return `${base}${mapped}${query}`;
  }

  return `${base}${path}${query}`;
}
