export type ChatTextPart = { text: string; href?: string };

function trimTrailingPunctuation(value: string): string {
  const pairs = [["(", ")"], ["[", "]"], ["{", "}"]] as const;
  const extraClosers = new Map<string, number>(pairs.map(([open, close]) => [
    close,
    [...value].filter((char) => char === close).length
      - [...value].filter((char) => char === open).length,
  ]));
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1];
    if (/[.,!?;:]/.test(last)) {
      end--;
    } else if (extraClosers.has(last) && extraClosers.get(last)! > 0) {
      extraClosers.set(last, extraClosers.get(last)! - 1);
      end--;
    } else {
      break;
    }
  }
  return value.slice(0, end);
}

export function linkifyChatText(text: string): ChatTextPart[] {
  const parts: ChatTextPart[] = [];
  let cursor = 0;
  const candidates = /(?:https?:\/\/|www\.)[^\s<>"'`“”‘’]+/gi;

  for (const match of text.matchAll(candidates)) {
    const start = match.index;
    // Do not turn a URL embedded in another scheme or identifier into a link.
    if (start > 0 && !/[\s([{<>"'`“”‘’]/.test(text[start - 1])) continue;
    const label = trimTrailingPunctuation(match[0]);
    // Reject controls, direction overrides, and backslash URL normalization.
    if (/[\p{Cc}\p{Cf}\\]/u.test(label)) continue;

    let url: URL;
    try {
      url = new URL(/^www\./i.test(label) ? `https://${label}` : label);
    } catch {
      continue;
    }
    // An explicit allowlist is required even if candidate matching changes.
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) continue;
    // Credentials can disguise the actual destination (trusted.example@evil.example).
    if (url.username || url.password) continue;

    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: label, href: url.href });
    cursor = start + label.length;
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
