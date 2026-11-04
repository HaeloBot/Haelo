import { createAppKit, type AppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { QueryClient } from "@tanstack/react-query";
import type { Config } from "wagmi";
import { DEFAULT_REOWN_PROJECT_ID } from "../site-config.js";
import { robinhoodChain } from "./robinhood.js";

export interface WalletKit {
  appkit: AppKit;
  wagmiConfig: Config;
  queryClient: QueryClient;
}

let kit: WalletKit | null = null;
let kitProject = "";

const queryClient = new QueryClient();

export function initAppKit(projectId = DEFAULT_REOWN_PROJECT_ID): WalletKit {
  const id = projectId.trim() || DEFAULT_REOWN_PROJECT_ID;
  if (kit && kitProject === id) return kit;
  const wagmi = new WagmiAdapter({
    projectId: id,
    networks: [robinhoodChain],
  });
  const appkit = createAppKit({
    adapters: [wagmi],
    projectId: id,
    networks: [robinhoodChain],
    defaultNetwork: robinhoodChain,
    allowUnsupportedChain: false,
    metadata: {
      name: "Haelo",
      description: "Autonomy ladder for AI trading agents",
      url: "https://haelobot.com",
      icons: ["https://haelobot.com/haelo-icon.png"],
    },
    themeMode: "dark",
    themeVariables: {
      "--w3m-accent": "#B8FA0C",
      "--w3m-color-mix": "#050605",
      "--w3m-color-mix-strength": 40,
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
    },
  });
  kitProject = id;
  kit = { appkit, wagmiConfig: wagmi.wagmiConfig, queryClient };
  return kit;
}
