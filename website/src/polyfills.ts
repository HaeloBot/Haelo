import { Buffer } from "buffer";

// @solana/web3.js expects Node's Buffer. Load this module before anything that imports it.
const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
