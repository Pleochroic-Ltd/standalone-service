/** Per-request size limits */
export const MAX = {
  /** One config document's JSON */
  configBytes: 256 * 1024,
  /** One secret's value */
  secretBytes: 16 * 1024,
  /** A skill's SKILL.md and the whole folder */
  skillMdBytes: 64 * 1024,
  skillBytes: 4 * 1024 * 1024,
  skillFiles: 200,
  /** One memory note */
  memoryBytes: 64 * 1024,
  /** Documents of one area per account */
  documents: 10_000,
  /** One batch of graph ops */
  graphBatchBytes: 8 * 1024 * 1024,
  graphBatchOps: 10_000,
  /** Inputs to one embeddings call, and one completion's prompt */
  embeddingInputs: 256,
  completeBytes: 512 * 1024,
  /** A fetch's content, and a search's result count */
  fetchChars: 400_000,
  searchCount: 20,
  /** Bodies of everything else */
  smallBody: 64 * 1024,
} as const;

/** Names: config ids, secret names, skill names, graph names */
export const NAME = {
  /** e.g. "openai-compatible/workbuddy" */
  configId: /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,3}$/,
  /** as in ${secret:NAME} */
  secret: /^[A-Z][A-Z0-9_]{0,63}$/,
  skill: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  graph: /^[a-z0-9][a-z0-9-]{0,62}$/,
  scope: /^(global|agent:[A-Za-z0-9._-]{1,64}|project:[0-9a-f]{8,64})$/,
} as const;

/* ---------- Secret-shaped strings ---------- */

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/, // OpenAI- and Anthropic-shaped API keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWTs
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // a long, unbroken base64 blob
];

/** How config data points at a secret */
const SECRET_REFERENCE = /^\$\{(secret|env):[A-Z0-9_]+\}$/;

/** Whether a string is shaped like a pasted key */
export function looksLikeSecret(value: string): boolean {
  if (SECRET_REFERENCE.test(value)) return false;
  return SECRET_PATTERNS.some((re) => re.test(value));
}

/** Nesting past this counts as a hit */
const MAX_DEPTH = 64;

/** The dotted path to the first string leaf that looks like a secret, or null */
export function findSecretLike(data: unknown, path = '$', depth = 0): string | null {
  if (depth > MAX_DEPTH) return path;
  if (typeof data === 'string') return looksLikeSecret(data) ? path : null;
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const hit = findSecretLike(data[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      const hit = findSecretLike(v, `${path}.${k}`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}
