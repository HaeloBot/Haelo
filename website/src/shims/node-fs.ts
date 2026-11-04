/** The playground never touches a disk. These exist so Haelo's modules can load in the browser. */

function refused(name: string): never {
  throw new Error(`Haelo's browser playground does not use the filesystem (${name}).`);
}

export function existsSync(): boolean {
  return false;
}

export function readFileSync(): never {
  return refused("readFileSync");
}

export function writeFileSync(): never {
  return refused("writeFileSync");
}

export function appendFileSync(): never {
  return refused("appendFileSync");
}

export function mkdirSync(): void {
  /* import-safe no-op; nothing is persisted */
}

export function renameSync(): never {
  return refused("renameSync");
}

export function chmodSync(): void {
  /* permissions are a server concern */
}

export function rmSync(): never {
  return refused("rmSync");
}

export function statSync(): never {
  return refused("statSync");
}

export function openSync(): never {
  return refused("openSync");
}

export function closeSync(): void {
  /* paired with openSync, which is never called */
}
