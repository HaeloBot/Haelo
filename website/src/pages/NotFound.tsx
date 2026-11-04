import { Link } from "react-router-dom";
import { Meta } from "../components/Meta.js";

export default function NotFound(): React.ReactElement {
  return (
    <div className="miss">
      <Meta title="Not found — Haelo" description="This page is not on the ladder." />
      <div>
        <p className="kicker">404</p>
        <h1 className="display glitch" data-text="OFF RUNG">
          Off rung
        </h1>
        <p className="lede" style={{ margin: "16px auto" }}>
          That path is not a rung. Shadow is back the other way.
        </p>
        <Link className="btn" to="/">
          Return to shadow
        </Link>
      </div>
    </div>
  );
}
