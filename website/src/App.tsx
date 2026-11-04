import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Chrome } from "./components/Chrome.js";
import { SiteConfigProvider } from "./components/SiteConfig.js";

const Landing = lazy(() => import("./pages/Landing.js"));
const Playground = lazy(() => import("./pages/Playground.js"));
const Docs = lazy(() => import("./pages/Docs.js"));
const Security = lazy(() => import("./pages/Security.js"));
const Pricing = lazy(() => import("./pages/Pricing.js"));
const About = lazy(() => import("./pages/About.js"));
const NotFound = lazy(() => import("./pages/NotFound.js"));
const Token = lazy(() => import("./pages/Token.js"));

function Fallback(): React.ReactElement {
  return (
    <div className="page">
      <p className="kicker">Loading</p>
    </div>
  );
}

export default function App(): React.ReactElement {
  const basename = import.meta.env.BASE_URL.replace(/\/$/, "");
  return (
    <BrowserRouter basename={basename}>
      <SiteConfigProvider>
      <Suspense fallback={<Fallback />}>
        <Routes>
          <Route element={<Chrome />}>
            <Route index element={<Landing />} />
            <Route path="token" element={<Token />} />
            <Route path="playground" element={<Playground />} />
            <Route path="docs" element={<Docs />} />
            <Route path="security" element={<Security />} />
            <Route path="pricing" element={<Pricing />} />
            <Route path="about" element={<About />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
      </SiteConfigProvider>
    </BrowserRouter>
  );
}
