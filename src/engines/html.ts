const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', deg: '°',
  plusmn: '±', euro: '€', pound: '£', yen: '¥', cent: '¢',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const value = NAMED_ENTITIES[body.toLowerCase()];
    return value ?? whole;
  });
}

/** The first quoted value of any of `names` in one opening tag */
function attr(tag: string, ...names: string[]): string | null {
  for (const name of names) {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
    if (m) return m[1] ?? m[2] ?? '';
  }
  return null;
}

/** <title>…</title>, decoded and trimmed */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const title = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 300) : null;
}

function removeNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|nav|noscript|head|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
}

/** Replaces every <pre> and standalone <code> block with a placeholder, keeping its text in `blocks` */
function extractCode(html: string, blocks: string[], markdown: boolean): string {
  const stash = (raw: string, fenced: boolean): string => {
    const text = decodeEntities(raw.replace(/<[^>]+>/g, ''));
    if (!markdown) blocks.push(fenced ? text.replace(/^\n+|\n+$/g, '') : text.trim());
    else blocks.push(fenced ? `\n\n\`\`\`\n${text.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n` : `\`${text.trim()}\``);
    return `\u0000${blocks.length - 1}\u0000`;
  };
  return html
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => stash(inner, true))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => stash(inner, false));
}

const restoreCode = (text: string, blocks: string[]): string => text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? '');

/** Converts the structural tags Markdown has notation for */
function toMarkdownSyntax(html: string): string {
  return html
    .replace(/<img\b([^>]*)\/?>/gi, (m, tagAttrs: string) => {
      const alt = attr(`<img ${tagAttrs}>`, 'alt') ?? '';
      const src = attr(`<img ${tagAttrs}>`, 'src');
      return src ? `![${alt}](${src})` : m;
    })
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, tagAttrs: string, inner: string) => {
      const href = attr(`<a ${tagAttrs}>`, 'href');
      return href ? `[${inner}](${href})` : inner;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${inner}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${inner}*`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner.trim()}`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner.trim()}\n\n`);
}

/** Tags that end a line of the rendered page */
const BLOCK_BREAK = /<\/(p|div|section|article|header|footer|main|aside|tr|table|thead|tbody|ul|ol|blockquote|figure|figcaption)>|<br\s*\/?>|<hr\s*\/?>/gi;

function collapseWhitespace(text: string): string {
  return text
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const collapseBlankLines = (text: string): string => text.replace(/\n{3,}/g, '\n\n').trim();

/** Regex passes that drop noise, set code aside, map structural tags, strip the rest and collapse whitespace */
function convert(html: string, markdown: boolean): string {
  const blocks: string[] = [];
  let text = extractCode(removeNoise(html), blocks, markdown);
  text = text.replace(BLOCK_BREAK, '\n');
  if (markdown) text = toMarkdownSyntax(text);
  else text = text.replace(/<li\b[^>]*>/gi, '\n').replace(/<h[1-6]\b[^>]*>/gi, '\n\n').replace(/<img\b[^>]*>/gi, '');
  text = text.replace(/<[^>]+>/g, markdown ? '' : ' ');
  text = decodeEntities(text);
  // Collapsed before the code is restored, so its whitespace survives
  text = collapseWhitespace(text);
  return collapseBlankLines(restoreCode(text, blocks));
}

export const htmlToMarkdown = (html: string): { title: string | null; text: string } => ({ title: extractTitle(html), text: convert(html, true) });
export const htmlToText = (html: string): { title: string | null; text: string } => ({ title: extractTitle(html), text: convert(html, false) });
