// src/redact.mjs
//
// Shared secret-redaction used by BOTH src/run.mjs (before a captured
// command's stdout/stderr tail is written into proof.json) and
// src/render.mjs (defense in depth against a hand-edited or older proof.json
// that might still carry something secret-shaped). Redaction runs on the raw
// text before any HTML-escaping, so an encoded variant can't slip past it.
//
// This is a pattern-based safety net, not a guarantee. It catches the shapes
// listed below; it is not a substitute for keeping real secrets out of
// command output in the first place. See the README's Limitations section.

const SECRET_PATTERNS = [
  // JSON Web Tokens: three dot-separated base64url segments, header always
  // starts with "eyJ" (base64 of `{"`).
  { label: 'JWT-shaped string', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Supabase publishable/secret keys.
  { label: 'Supabase key', re: /\bsb[ph]_[A-Za-z0-9]{20,}\b/g },
  // GitHub tokens: ghp_ (personal), gho_ (oauth), ghu_ (user-to-server),
  // ghs_ (server-to-server), ghr_ (refresh).
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  // AWS access key IDs.
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Google API keys.
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // A connection string with credentials embedded (postgres://, mysql://,
  // mongodb://, redis://, ...): scheme://user:password@host.
  { label: 'connection string with embedded credentials', re: /\b\w+:\/\/[^\s"'<>]*:[^\s"'<>@]+@[^\s"'<>]+/gi },
  // PEM private key blocks.
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Generic "name=value" / "name: value" pairs whose name looks like a
  // secret and whose value is long enough to plausibly be one. Requires
  // 12+ characters of value so short, clearly-non-secret values (e.g.
  // `token: abc`) are left alone.
  {
    label: 'possible secret assignment',
    re: /\b[\w-]*(?:secret|token|passwd|password|api[_-]?key)[\w-]*\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{12,}["']?/gi,
  },
];

/**
 * Redact secret-shaped substrings in raw text.
 * @param {string} input
 * @returns {{ text: string, redactedCount: number }}
 */
export function redactSecrets(input) {
  let text = String(input);
  let redactedCount = 0;
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    text = text.replace(re, () => {
      redactedCount++;
      return '[REDACTED]';
    });
  }
  return { text, redactedCount };
}

/**
 * True if raw text still contains something secret-shaped. Used as a
 * defense-in-depth scan over rendered HTML, independent of whether
 * redactSecrets() already ran on the way in.
 * @param {string} input
 * @returns {boolean}
 */
export function containsSecretShape(input) {
  const text = String(input);
  return SECRET_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

export const SECRET_LABELS = SECRET_PATTERNS.map((p) => p.label);
