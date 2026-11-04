import { useEffect, useState } from "react";
import { sound } from "../audio/sound.js";

const LINES = [
  "HAELO  0.2.0",
  "HALO  IGNITION",
  "AUDIT  GENESIS  0000…0000",
  "RUNG  SHADOW",
  "LIVE  DISABLED",
  "BROKER KEYS  NOT IN THIS BROWSER",
];

export function Intro({ onDone }: { onDone: () => void }): React.ReactElement {
  const [left, setLeft] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(onDone, 4600);
    return () => window.clearTimeout(id);
  }, [onDone]);

  useEffect(() => {
    if (sound.playing) sound.ignite();
  }, []);

  return (
    <div className={left ? "intro" : "intro"} role="dialog" aria-label="Haelo introduction">
      <div className="intro-inner">
        <svg className="halo-svg" viewBox="0 0 240 120" aria-hidden="true">
          <ellipse className="halo-ring" cx="120" cy="60" rx="92" ry="28" />
        </svg>
        <h1 className="display glitch" data-text="HAELO">
          HAELO
        </h1>
        <div className="boot" aria-hidden="true">
          {LINES.map((line, i) => (
            <div key={line} style={{ animationDelay: `${1.15 + i * 0.28}s` }}>
              {line}
            </div>
          ))}
        </div>
      </div>
      <button
        className="intro-skip"
        type="button"
        onClick={() => {
          setLeft(true);
          onDone();
        }}
      >
        Skip
      </button>
    </div>
  );
}
