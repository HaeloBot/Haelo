import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Solana wallets through the Wallet Standard: Phantom, Solflare, Backpack and any other standard wallet the visitor
 * has installed are detected automatically. No wallet-specific adapters, no project id, no private key on this page.
 */
export function SolanaWallet({ rpcUrl, children }: { rpcUrl: string; children: ReactNode }): React.ReactElement {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={rpcUrl}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
