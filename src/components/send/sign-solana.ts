import { toBase64, performMpcSign, clientKeys, restoreKeyHandles, clearClientKey } from "../../lib/mpc";
import { authHeaders } from "../../lib/auth";
import { apiUrl } from "../../lib/apiBase";
import { sensitiveHeaders } from "../../lib/passkey";
import { parseUnits } from "../../lib/chains/evmTx";
import {
  buildSolanaTransferMessage,
  buildSplTransferMessage,
  assembleSolanaTransaction,
  getLatestBlockhash,
  broadcastSolanaTransaction,
  waitForSolanaConfirmation,
  checkAtaExists,
  findAssociatedTokenAddress,
} from "../../lib/chains/solanaTx";
import { base58 } from "@scure/base";
import type { SigningContext } from "./signing-flows";
import { friendlyError } from "./signing-flows";

export async function executeSolanaSigningFlow(ctx: SigningContext): Promise<void> {
  const {
    keyFile, chain, asset, address, to, amount,
    confirmBeforeBroadcast,
    onTxSubmitted, onTxConfirmed,
    setStep, setSigningPhase, setSignatureCount, setSigningError,
    setSignedRawTx, setTxResult, setPendingTxHash, setKeyFile, setPendingEncrypted,
    t,
  } = ctx;

  if (!chain.rpcUrl) return;

  setStep("signing");
  setSigningPhase("building-tx");
  setSignatureCount(1);
  setSigningError(null);

  try {
    // Restore key handles if not in memory
    if (!clientKeys.has(keyFile.id)) {
      await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
    }

    // 1. Build unsigned transaction message
    const fromPubKey = base58.decode(address);
    const toPubKey = base58.decode(to);
    const tokenAmount = parseUnits(amount, asset.decimals);
    const recentBlockhash = await getLatestBlockhash(chain.rpcUrl);

    let message: Uint8Array;
    if (!asset.isNative && asset.contractAddress) {
      const mint = base58.decode(asset.contractAddress);
      const destAta = findAssociatedTokenAddress(toPubKey, mint);
      const needsCreateAta = !(await checkAtaExists(chain.rpcUrl, base58.encode(destAta)));
      message = buildSplTransferMessage({
        from: fromPubKey, to: toPubKey, mint, amount: tokenAmount,
        decimals: asset.decimals, recentBlockhash, createAta: needsCreateAta,
      });
    } else {
      message = buildSolanaTransferMessage({ from: fromPubKey, to: toPubKey, lamports: tokenAmount, recentBlockhash });
    }

    // 2. MPC EdDSA signing
    setSigningPhase("mpc-signing");

    const { signature: sigRaw, sessionId } = await performMpcSign({
      algorithm: "eddsa",
      keyId: keyFile.id,
      hash: message,
      initPayload: { id: keyFile.id, algorithm: "eddsa", from: address, chainType: "solana", unsignedTx: toBase64(message) },
      headers: sensitiveHeaders(),
    });

    // 3. Assemble signed transaction
    const signedTxBase58 = assembleSolanaTransaction(message, sigRaw);

    if (confirmBeforeBroadcast) {
      setSignedRawTx(signedTxBase58);
      setTxResult({ status: "success", txHash: "sign-only" });
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");
      return;
    }

    // 4. Broadcast
    setSigningPhase("broadcasting");
    const txSig = await broadcastSolanaTransaction(chain.rpcUrl, signedTxBase58);

    fetch(apiUrl("/api/sign/broadcast"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash: txSig, chainId: chain.id }),
    }).catch(() => {});

    onTxSubmitted?.(txSig, to, amount);

    // 5. Poll for confirmation
    setPendingTxHash(txSig);
    setSigningPhase("polling");
    const result = await waitForSolanaConfirmation(chain.rpcUrl, txSig, () => {}, 60, 2000);

    setTxResult({
      status: result.confirmed ? "success" : "pending",
      txHash: txSig,
      blockNumber: result.slot,
    });
    if (result.confirmed) onTxConfirmed?.(txSig);
    setKeyFile(null); setPendingEncrypted(null);
    setStep("result");

  } catch (err: unknown) {
    console.error("[send] Solana Error:", err);
    setSigningError(friendlyError(err, t));
  } finally {
    clearClientKey(keyFile.id);
  }
}
