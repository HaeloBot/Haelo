import { useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { sound } from "../audio/sound.js";

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Hide the decorative cursor while the wallet modal covers the page, so the native pointer stays usable. */
function syncWalletCursor(open: boolean): void {
  document.documentElement.classList.toggle("wallet-open", open);
}

export default function WalletButton(): React.ReactElement {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { visible, setVisible } = useWalletModal();
  const saw = useRef(false);

  useEffect(() => {
    syncWalletCursor(visible);
    return () => document.documentElement.classList.remove("wallet-open");
  }, [visible]);

  useEffect(() => {
    if (!saw.current) {
      saw.current = true;
      return;
    }
    if (connected) sound.levelUp();
  }, [connected]);

  if (connected && publicKey) {
    const address = publicKey.toBase58();
    return (
      <button
        className="wallet wallet-chip"
        type="button"
        aria-label={`Connected ${wallet?.adapter.name ?? "wallet"} ${shortAddress(address)}. Click to disconnect.`}
        title="Disconnect"
        onClick={() => void disconnect()}
      >
        <span className="wallet-halo" aria-hidden="true" />
        {shortAddress(address)}
      </button>
    );
  }

  return (
    <button className="wallet" type="button" aria-label="Connect a Solana wallet" disabled={connecting} onClick={() => setVisible(true)}>
      <span className="wallet-long">{connecting ? "Connecting" : "Connect wallet"}</span>
      <span className="wallet-short">{connecting ? "…" : "Connect"}</span>
    </button>
  );
}
