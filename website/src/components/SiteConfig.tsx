import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { FALLBACK_CONFIG, loadSiteConfig, type SiteConfig } from "../site-config.js";

const Ctx = createContext<SiteConfig>(FALLBACK_CONFIG);

export function SiteConfigProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [cfg, setCfg] = useState<SiteConfig>(FALLBACK_CONFIG);
  useEffect(() => {
    let cancel = false;
    void loadSiteConfig().then((next) => {
      if (!cancel) setCfg(next);
    });
    return () => {
      cancel = true;
    };
  }, []);
  return <Ctx.Provider value={cfg}>{children}</Ctx.Provider>;
}

export function useSiteConfig(): SiteConfig {
  return useContext(Ctx);
}
