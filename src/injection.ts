/**
 * Heuristic detector for instruction-injection text inside tool results (news, filings, notes, order memos).
 *
 * This is a TRIPWIRE, not a wall. Pattern matching is evadable by a determined attacker. The real
 * protection is the hard rails: even a fully hijacked agent cannot exceed caps, leave the account wall,
 * or skip the ladder. Flags exist to demote earlier and to leave evidence.
 */
export interface InjectionMatch {
  rule: string;
  excerpt: string;
}

const RULES: Array<[string, RegExp]> = [
  ["ignore_previous", /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,40}\b(instructions?|rules?|prompts?|constraints?|limits?)\b/i],
  ["new_instructions", /\b(new|updated|revised)\s+(system\s+)?(instructions?|directive|orders?)\b/i],
  ["role_header", /(^|\n)\s*(system|assistant|developer)\s*(message)?\s*:/i],
  ["chat_template_token", /<\|?(im_start|im_end|system|endoftext)\|?>|\[\/?INST\]|<<\/?SYS>>/i],
  ["act_as_agent", /\b(you\s+(must|should|are\s+now|will)\b[^.\n]{0,60}\b(buy|sell|trade|transfer|place|execute|send|withdraw|liquidate)\b)/i],
  ["direct_trade_command", /\b(immediately|right\s+now|urgent(ly)?)\b[^.\n]{0,60}\b(buy|sell|liquidate|market\s+order|all[- ]in)\b/i],
  ["limit_tampering", /\b(raise|increase|remove|lift|disable|bypass|ignore)\b[^.\n]{0,30}\b(cap|limit|guardrail|policy|restriction|approval|safeguard)s?\b/i],
  ["secrecy", /\b(do\s+not|don't|never)\s+(tell|inform|notify|alert|mention|show)\b[^.\n]{0,30}\b(user|human|owner|operator)\b/i],
  ["exfiltration", /\b(send|post|email|upload|exfiltrate)\b[^.\n]{0,40}\b(api[-_ ]?key|secret|token|password|private[-_ ]?key|credentials?)\b/i],
  ["tool_call_syntax", /\b(call|invoke|use)\s+(the\s+)?(tool|function)\s+[`"']?[a-z_]{3,}[`"']?\s+with\b/i],
  ["jailbreak_phrase", /\b(developer\s+mode|jailbreak|DAN\s+mode|as\s+an\s+unrestricted)\b/i],
];

// Unicode tag block and zero-width / bidi controls are commonly used to hide instructions from humans.
const HIDDEN_CHARS = /[\u{E0000}-\u{E007F}\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069]/u;

export function scanText(text: string): InjectionMatch[] {
  const matches: InjectionMatch[] = [];
  if (!text) return matches;
  for (const [rule, re] of RULES) {
    const m = re.exec(text);
    if (m) matches.push({ rule, excerpt: m[0].trim().slice(0, 120) });
  }
  if (HIDDEN_CHARS.test(text)) matches.push({ rule: "hidden_characters", excerpt: "(invisible or bidirectional control characters)" });
  return matches;
}

/** Collect every string in an MCP tool result (text content blocks, structured content). */
export function collectResultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
  };
  walk(result.content, 0);
  walk(result.structuredContent, 0);
  return parts.join("\n");
}

export interface TaintState {
  /** Epoch ms of the last flagged result. */
  flaggedAtMs?: number;
  /** Calls made since the last flagged result. */
  callsSince: number;
  rules: string[];
}

export function newTaint(): TaintState {
  return { callsSince: 0, rules: [] };
}

export function flag(t: TaintState, nowMs: number, matches: InjectionMatch[]): void {
  t.flaggedAtMs = nowMs;
  t.callsSince = 0;
  t.rules = [...new Set(matches.map((m) => m.rule))];
}

/** True while a flagged result is recent enough that an order should be treated as possible follow-through. */
export function isTainted(t: TaintState, nowMs: number, windowCalls: number, windowSeconds: number): boolean {
  if (t.flaggedAtMs === undefined) return false;
  return t.callsSince <= windowCalls && nowMs - t.flaggedAtMs <= windowSeconds * 1000;
}
