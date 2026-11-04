export function dirname(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  if (i <= 0) return i === 0 ? "/" : ".";
  return norm.slice(0, i);
}

export function join(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("/").replace(/\/{2,}/g, "/");
}

export function resolve(...parts: string[]): string {
  return join(...parts);
}
