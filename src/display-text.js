// The names people give: a person's name, a journey's name and its place or season, a moment's
// title, a kind of moment they name themselves, and a place they type (owner, Oct 10, 2026). Any
// language, script, symbol or emoji is welcome in them, and their limits are counted in what a
// person sees: "👨‍👩‍👧‍👦" is one character, not the eleven a JavaScript string's length makes it. The
// server, the web and the phone all count with this one file, so a name one of them accepts is
// never refused by another, and none of them ever cuts a character in half.

// A character a person sees can be built from several code points: a family is seven, a kiss
// between two people with skin tones ten. Beyond the count a person sees, a name may hold ten
// code points for each character it is allowed, so a run of stacked accents, which still counts
// as one character, cannot make a name of unbounded size. The database holds the same ceiling.
export const CODE_POINTS_PER_CHARACTER = 10;

// Characters a name never keeps. C0 and C1 controls are not text. The bidirectional embeddings,
// overrides (U+202A–U+202E) and isolates (U+2066–U+2069) are invisible and can make a name read
// in a different order from the one it was written in, in History above all. The zero-width
// joiner and the variation selectors stay: an emoji needs them to be drawn as one.
const LINE_BREAKS = /[\t\n\v\f\r\u0085]+/g;
const REMOVED = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;

/**
 * A name as it is kept: line breaks and tabs become a space, other control characters and every
 * direction override or isolate are taken out, the rest is composed (NFC), and the ends are
 * trimmed. What is left may be empty, and the caller decides whether that is allowed.
 */
export function cleanDisplayText(value) {
  return String(value ?? '').replace(LINE_BREAKS, ' ').replace(REMOVED, '').normalize('NFC').trim();
}

const segmenter = typeof Intl === 'object' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** The characters a person sees in `text`, each one a whole grapheme cluster. */
export function characters(text) {
  const value = String(text ?? '');
  return segmenter ? Array.from(segmenter.segment(value), (part) => part.segment) : graphemesByRule(value);
}

/** How many characters a person sees in `text`. */
export function characterCount(text) {
  return characters(text).length;
}

const codePointCount = (text) => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};

/** Whether `text` is within a limit of `max` characters, counted as a person sees them. */
export function fitsLimit(text, max) {
  const value = String(text ?? '');
  return characterCount(value) <= max && codePointCount(value) <= max * CODE_POINTS_PER_CHARACTER;
}

/** The longest beginning of `text` within `max` characters. Never ends partway into one. */
export function clipToLimit(text, max) {
  const value = String(text ?? '');
  if (fitsLimit(value, max)) return value;
  let kept = '';
  let count = 0;
  let points = 0;
  for (const character of characters(value)) {
    const size = codePointCount(character);
    if (count + 1 > max || points + size > max * CODE_POINTS_PER_CHARACTER) break;
    kept += character;
    count += 1;
    points += size;
  }
  return kept;
}

/**
 * What a box limited to `max` characters holds after an edit turned `previous` into `next`, the
 * way a browser's maxlength does it but counted in characters: when the edit would go past the
 * limit, only as much of what was typed or pasted is kept as fits, wherever it went, and what was
 * there already stays. `caret` is where the cursor belongs afterwards, as a string index.
 */
export function fitTyping(previous, next, max) {
  const before = String(previous ?? '');
  const after = String(next ?? '');
  if (fitsLimit(after, max)) return { value: after, caret: null };
  // What stayed the same at each end, in whole code points so a surrogate pair is never split.
  const old = Array.from(before);
  const now = Array.from(after);
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start += 1;
  let end = 0;
  while (end < old.length - start && end < now.length - start && old[old.length - 1 - end] === now[now.length - 1 - end]) end += 1;
  const head = now.slice(0, start).join('');
  const tail = now.slice(now.length - end).join('');
  const typed = now.slice(start, now.length - end).join('');
  // As many whole characters of what was typed as leave room, fewest first if joining them to
  // their neighbours would change the count.
  const pieces = characters(typed);
  let kept = pieces.length;
  while (kept > 0 && !fitsLimit(head + pieces.slice(0, kept).join('') + tail, max)) kept -= 1;
  const inserted = pieces.slice(0, kept).join('');
  const value = head + inserted + tail;
  if (fitsLimit(value, max)) return { value, caret: head.length + inserted.length };
  // Only when what was there already is past the limit, which a box that started within it
  // cannot reach by typing.
  const clipped = clipToLimit(value, max);
  return { value: clipped, caret: clipped.length };
}

// Grapheme clusters by the rules of Unicode's UAX #29, for an engine without Intl.Segmenter.
// Every current browser and Node have it; a phone's JavaScript engine may not. The rules here are
// the extended grapheme cluster rules, enough to agree with Intl.Segmenter on every script and
// emoji a name is likely to hold, and tests/display-text.test.js holds the two side by side.
const CONTROL = 1;
const EXTEND = 2;
const ZWJ = 3;
const REGIONAL = 4;
const PREPEND = 5;
const PICTOGRAPHIC = 6;
const L = 7;
const V = 8;
const T = 9;
const LV = 10;
const LVT = 11;
const SPACING = 12;
const OTHER = 0;

const EXTEND_PATTERN = /[\p{Mn}\p{Me}\u200C\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;
const SPACING_PATTERN = /\p{Mc}/u;
const PREPEND_PATTERN = /[\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\u0D4E\u{110BD}\u{110CD}\u{111C2}\u{111C3}\u{1193F}\u{11941}\u{11A3A}\u{11A84}-\u{11A89}\u{11D46}\u{11F02}]/u;
const CONTROL_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/u;
const PICTOGRAPHIC_PATTERN = /\p{Extended_Pictographic}/u;
// Indic conjuncts (GB9c): a consonant, a virama, and the next consonant are one character.
const LINKER_PATTERN = /[\u094D\u09CD\u0ACD\u0B4D\u0C4D\u0D4D]/u;
const CONSONANT_PATTERN = /[\u0915-\u0939\u0958-\u095F\u0978-\u097F\u0995-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09DC\u09DD\u09DF\u09F0\u09F1\u0A95-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0AF9\u0B15-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B5C\u0B5D\u0B5F\u0B71\u0C15-\u0C28\u0C2A-\u0C39\u0C58-\u0C5A\u0D15-\u0D3A]/u;

function breakClass(character, point) {
  if (point === 0x200D) return ZWJ;
  if (point === 0x0D || point === 0x0A) return CONTROL;
  if (point >= 0x1F1E6 && point <= 0x1F1FF) return REGIONAL;
  if (EXTEND_PATTERN.test(character)) return EXTEND;
  if (SPACING_PATTERN.test(character)) return SPACING;
  if (PREPEND_PATTERN.test(character)) return PREPEND;
  if (CONTROL_PATTERN.test(character)) return CONTROL;
  if ((point >= 0x1100 && point <= 0x115F) || (point >= 0xA960 && point <= 0xA97C)) return L;
  if ((point >= 0x1160 && point <= 0x11A7) || (point >= 0xD7B0 && point <= 0xD7C6)) return V;
  if ((point >= 0x11A8 && point <= 0x11FF) || (point >= 0xD7CB && point <= 0xD7FB)) return T;
  if (point >= 0xAC00 && point <= 0xD7A3) return (point - 0xAC00) % 28 === 0 ? LV : LVT;
  if (PICTOGRAPHIC_PATTERN.test(character)) return PICTOGRAPHIC;
  return OTHER;
}

function graphemesByRule(text) {
  const clusters = [];
  let current = '';
  let previous = null;
  let previousPoint = 0;
  let regionalRun = 0;
  let pictographic = 0; // 1: a pictograph, then any marks; 2: and then a zero-width joiner
  let conjunct = 0; // 1: a consonant, then any marks; 2: and then a virama
  for (const character of text) {
    const point = character.codePointAt(0);
    const kind = breakClass(character, point);
    const consonant = CONSONANT_PATTERN.test(character);
    const linker = LINKER_PATTERN.test(character);
    let join = false;
    if (previous === null) join = false;
    else if (previousPoint === 0x0D && point === 0x0A) join = true;
    else if (previous === CONTROL || kind === CONTROL) join = false;
    else if (previous === L && (kind === L || kind === V || kind === LV || kind === LVT)) join = true;
    else if ((previous === LV || previous === V) && (kind === V || kind === T)) join = true;
    else if ((previous === LVT || previous === T) && kind === T) join = true;
    else if (kind === EXTEND || kind === ZWJ || kind === SPACING) join = true;
    else if (previous === PREPEND) join = true;
    else if (consonant && conjunct === 2) join = true;
    else if (kind === PICTOGRAPHIC && pictographic === 2 && previous === ZWJ) join = true;
    else if (previous === REGIONAL && kind === REGIONAL && regionalRun % 2 === 1) join = true;
    if (!join && current) {
      clusters.push(current);
      current = '';
    }
    current += character;
    regionalRun = kind === REGIONAL ? (join ? regionalRun + 1 : 1) : 0;
    if (kind === PICTOGRAPHIC) pictographic = 1;
    else if (kind === EXTEND && pictographic === 1) pictographic = 1;
    else if (kind === ZWJ && pictographic === 1) pictographic = 2;
    else pictographic = 0;
    if (consonant) conjunct = 1;
    else if (linker && conjunct >= 1) conjunct = 2;
    else if (kind !== ZWJ && (kind !== EXTEND || point === 0x200C)) conjunct = 0;
    previous = kind;
    previousPoint = point;
  }
  if (current) clusters.push(current);
  return clusters;
}

/** For tests: the rule-based segmentation a phone without Intl.Segmenter uses. */
export const graphemesWithoutSegmenter = graphemesByRule;
