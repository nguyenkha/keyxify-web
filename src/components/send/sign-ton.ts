import { performMpcSign, clientKeys, restoreKeyHandles, clearClientKey } from "../../lib/mpc";
import { authHeaders } from "../../lib/auth";
import { apiUrl } from "../../lib/apiBase";
import { sensitiveHeaders } from "../../lib/passkey";
import {
  buildTonTransferMessage,
  buildTonJettonTransferMessage,
  resolveJettonWalletAddress,
  assembleTonSignedMessage,
  broadcastTonTransaction,
  waitForTonConfirmation,
  getTonSeqno,
  isTonWalletInitialized,
} from "../../lib/chains/tonTx";
import { publicKeyToTonAddress } from "../../lib/chains/tonAdapter";
import type { SigningContext } from "./signing-flows";
import { friendlyError } from "./signing-flows";

export async function executeTonSigningFlow(ctx: SigningContext): Promise<void> {
  const {
    keyFile, chain, asset, to, amount,
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
    if (!clientKeys.has(keyFile.id)) {
      await restoreKeyHandles(keyFile.id, keyFile.share, keyFile.eddsaShare);
    }

    // 1. Derive address and fetch needed data (staggered to avoid toncenter 1 req/s limit)
    const fromAddress = publicKeyToTonAddress(keyFile.eddsaPublicKey);
    const isJetton = !asset.isNative && !!asset.contractAddress;

    // Stagger all toncenter calls sequentially (free tier: 1 req/sec)
    let jettonWalletAddress: string | undefined;
    if (isJetton) {
      jettonWalletAddress = await resolveJettonWalletAddress(
        chain.rpcUrl, asset.contractAddress!, fromAddress,
      );
      await new Promise((r) => setTimeout(r, 1500));
    }
    const seqno = await getTonSeqno(chain.rpcUrl, fromAddress);
    // seqno > 0 means wallet is definitely deployed — skip the extra API call
    let walletInitialized = seqno > 0;
    if (!walletInitialized) {
      await new Promise((r) => setTimeout(r, 1500));
      walletInitialized = await isTonWalletInitialized(chain.rpcUrl, fromAddress);
    }

    // 2. Build unsigned transfer message (native TON or Jetton)
    let hash: Uint8Array;
    let unsignedBody: string;

    if (!isJetton) {
      ({ hash, unsignedBody } = buildTonTransferMessage({
        eddsaPubKeyHex: keyFile.eddsaPublicKey,
        to,
        amount,
        seqno,
      }));
    } else {
      const jettonAmount = BigInt(
        Math.round(parseFloat(amount.replace(/,/g, "")) * 10 ** asset.decimals),
      );
      ({ hash, unsignedBody } = buildTonJettonTransferMessage({
        eddsaPubKeyHex: keyFile.eddsaPublicKey,
        senderAddress: fromAddress,
        jettonWalletAddress: jettonWalletAddress!,
        to,
        jettonAmount,
        seqno,
      }));
    }

    // 3. MPC EdDSA signing
    setSigningPhase("mpc-signing");

    const { signature: sigRaw, sessionId } = await performMpcSign({
      algorithm: "eddsa",
      keyId: keyFile.id,
      hash,
      initPayload: {
        id: keyFile.id,
        algorithm: "eddsa",
        from: fromAddress,
        chainType: "ton",
        unsignedTx: unsignedBody,
        eddsaPublicKey: keyFile.eddsaPublicKey,
        tonTx: {
          to,
          amount,
          seqno,
          ...(asset.isNative ? {} : {
            contractAddress: asset.contractAddress,
            jettonWalletAddress,
            symbol: asset.symbol,
          }),
        },
      },
      headers: sensitiveHeaders(),
    });

    // 4. Assemble signed external message (include state init if wallet not yet deployed)
    const signedBoc = assembleTonSignedMessage(fromAddress, unsignedBody, sigRaw, {
      eddsaPubKeyHex: keyFile.eddsaPublicKey,
      includeStateInit: !walletInitialized,
    });

    if (confirmBeforeBroadcast) {
      setSignedRawTx(signedBoc);
      setTxResult({ status: "success", txHash: "sign-only" });
      setKeyFile(null); setPendingEncrypted(null);
      setStep("result");
      return;
    }

    // 5. Broadcast
    setSigningPhase("broadcasting");
    const txHash = await broadcastTonTransaction(chain.rpcUrl, signedBoc);

    fetch(apiUrl("/api/sign/broadcast"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ keyShareId: keyFile.id, sessionId, txHash, chainId: chain.id }),
    }).catch(() => {});

    onTxSubmitted?.(txHash, to, amount);

    // 6. Poll for confirmation (check seqno increment)
    setPendingTxHash(txHash);
    setSigningPhase("polling");
    const result = await waitForTonConfirmation(chain.rpcUrl, fromAddress, seqno, () => {}, 30, 3000);

    setTxResult({
      status: result.confirmed ? "success" : "pending",
      txHash,
    });
    if (result.confirmed) onTxConfirmed?.(txHash);
    setKeyFile(null); setPendingEncrypted(null);
    setStep("result");

  } catch (err: unknown) {
    console.error("[send] TON Error:", err);
    setSigningError(friendlyError(err, t));
  } finally {
    clearClientKey(keyFile.id);
  }
}
