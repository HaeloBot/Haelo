import { useEffect, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useAppKitAccount, useAppKitState } from "@reown/appkit/react";
import { sound } from "../audio/sound.js";
import { initAppKit, type WalletKit } from "../wallet/appkit.js";

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function syncAppKitCursor(open: boolean): void {
  document.documentElement.classList.toggle("appkit-open", open);
}

/** Hide the decorative cursor while the wallet modal covers the page. */
function AppKitCursor({ kit }: { kit: WalletKit }): null {
  const { open } = useAppKitState();

  useEffect(() => {
    syncAppKitCursor(open);
  }, [open]);

  useEffect(() => {
    syncAppKitCursor(kit.appkit.getState().open);
    const unsubscribe = kit.appkit.subscribeState((state) => {
      syncAppKitCursor(state.open);
    });
    return () => {
      unsubscribe();
      document.documentElement.classList.remove("appkit-open");
    };
  }, [kit]);

  return null;
}

function WalletReady({ kit }: { kit: WalletKit }): React.ReactElement {
  const { address, isConnected } = useAppKitAccount();
  const saw = useRef(false);

  useEffect(() => {
    if (!saw.current) {
      saw.current = true;
      return;
    }
    if (isConnected) sound.levelUp();
  }, [isConnected]);

  if (isConnected && address) {
    return (
      <>
        <AppKitCursor kit={kit} />
        <button className="wallet wallet-chip" type="button" aria-label={`Connected wallet ${shortAddress(address)}`} onClick={() => void kit.appkit.open()}>
          <span className="wallet-halo" aria-hidden="true" />
          {shortAddress(address)}
        </button>
      </>
    );
  }

  return (
    <>
      <AppKitCursor kit={kit} />
      <button className="wallet" type="button" aria-label="Connect wallet" onClick={() => void kit.appkit.open()}>
        <span className="wallet-long">Connect wallet</span>
        <span className="wallet-short">Connect</span>
      </button>
    </>
  );
}

export default function WalletButton({ projectId }: { projectId: string }): React.ReactElement {
  const [kit, setKit] = useState<WalletKit | null>(null);

  useEffect(() => {
    let cancel = false;
    try {
      const next = initAppKit(projectId);
      if (!cancel) setKit(next);
    } catch {
      if (!cancel) setKit(null);
    }
    return () => {
      cancel = true;
    };
  }, [projectId]);

  if (!kit) {
    return (
      <button className="wallet" type="button" disabled aria-label="Connect wallet">
        <span className="wallet-long">Connect wallet</span>
        <span className="wallet-short">Connect</span>
      </button>
    );
  }

  return (
    <WagmiProvider config={kit.wagmiConfig}>
      <QueryClientProvider client={kit.queryClient}>
        <WalletReady kit={kit} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
