// mend — one patch tool for every AI edit format (SPEC.md sections 1-10).
// Reads a unified diff, SEARCH/REPLACE blocks, a V4A patch or JSON edits,
// finds the target lines at the first matching whitespace tier, and applies
// every edit or none of them. Node 22, standard library only.
//
// Trial mode: when MAKEFUN_ENV_URL is set this file hands over to runner.ts
// (see the bottom of the file); otherwise it runs as the mend CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown for exit-2 failures; `line` is the exact stdout line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown when a single edit fails; carries the failure code and path. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** Split patch text into patch lines: at \n, one trailing \r dropped, no empty tail piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a safe relative path. */
function pathIsSafe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

function demandSafe(p: string): void {
  if (!pathIsSafe(p)) throw new EditFail('unsafe', p);
}

/**
 * The working tree as edits see it. `state` holds the post-edit text of every
 * path an edit has touched (null = deleted); untouched paths read from disk.
 * `before` remembers each path's original text so the final report can tell
 * A/D/M apart, and `moves` records successful move edits for R lines.
 */
class Tree {
  private readonly before = new Map<string, string | null>();
  readonly state = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  current(p: string): string | null {
    return this.state.has(p) ? this.state.get(p)! : this.original(p);
  }

  put(p: string, text: string | null): void {
    this.state.set(p, text);
  }
}

type Edit = (tree: Tree) => void;

/** A file broken into lines plus the facts needed to write it back byte-faithfully. */
interface FileBody {
  lines: string[];
  eol: string; // '\r\n' or '\n'
  endsWithEol: boolean;
}

function dissect(text: string): FileBody {
  if (text === '') return { lines: [], eol: '\n', endsWithEol: false };
  const firstNl = text.indexOf('\n');
  const eol = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(eol);
  const endsWithEol = text.endsWith(eol);
  if (endsWithEol) lines.pop();
  return { lines, eol, endsWithEol };
}

function assemble(lines: string[], eol: string, endsWithEol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(eol) + (endsWithEol ? eol : '');
}

/** A freshly created file: LF breaks, trailing break unless told otherwise. */
function createText(lines: string[], trailingBreak = true): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailingBreak ? '\n' : '');
}

// ---- section 5: three-tier line matching ---------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineMatchesAtTier(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return stripTrail(fileLine) === stripTrail(patchLine);
  return stripBoth(fileLine) === stripBoth(patchLine);
}

interface MatchHit {
  tier: number;
  starts: number[]; // every occurrence start at that tier, ascending
}

/**
 * Find old lines `old` inside `hay` at or after index `from`. Tiers are tried
 * in order (tier 0 only when strict); the first tier with any hit wins.
 * Returns null when no tier matches.
 */
function locate(hay: string[], old: string[], from: number, strict: boolean): MatchHit | null {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier++) {
    const starts: number[] = [];
    for (let i = Math.max(0, from); i + old.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < old.length; j++) {
        if (!lineMatchesAtTier(hay[i + j]!, old[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) starts.push(i);
    }
    if (starts.length > 0) return { tier, starts };
  }
  return null;
}

/** Single-line version of locate, used for V4A anchors. */
function locateOne(hay: string[], needle: string, from: number, strict: boolean): MatchHit | null {
  return locate(hay, [needle], from, strict);
}

/**
 * Build the replacement lines for a matched region. `kinds` walks the hunk /
 * chunk body in order: 'ctx' lines take the file's own matched line, 'del'
 * lines vanish, 'add' lines come from the patch — re-indented at tier 2 by
 * swapping the old first line's leading whitespace P for the file's F.
 */
function replacementFor(
  kinds: string[],
  addTexts: string[],
  fileLines: string[],
  start: number,
  oldFirst: string,
  tier: number,
): string[] {
  const out: string[] = [];
  let oi = 0; // index into the matched region
  let ai = 0; // index into addTexts
  const fileLead = fileLines.length > 0 ? leadWs(fileLines[0]!) : '';
  const patchLead = leadWs(oldFirst);
  for (const kind of kinds) {
    if (kind === 'ctx') {
      out.push(fileLines[oi]!);
      oi++;
    } else if (kind === 'del') {
      oi++;
    } else {
      let text = addTexts[ai++]!;
      if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(patchLead)) {
        text = fileLead + text.slice(patchLead.length);
      }
      out.push(text);
    }
  }
  return out;
}

/**
 * For SEARCH/REPLACE blocks the new lines are a plain list (no context
 * markers); at tier 2 each non-blank one is re-indented like an 'add' line.
 */
function reindentList(texts: string[], fileFirst: string, oldFirst: string, tier: number): string[] {
  if (tier !== 2) return [...texts];
  const fileLead = leadWs(fileFirst);
  const patchLead = leadWs(oldFirst);
  return texts.map((t) =>
    t !== '' && t.trim() !== '' && t.startsWith(patchLead) ? fileLead + t.slice(patchLead.length) : t,
  );
}

// ---- section 4: format detection ------------------------------------------

function detectFormat(lines: string[]): string | null {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) return null;
  if (lines[firstIdx]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[firstIdx]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const unified = lines.some(
    (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
  );
  return unified ? 'unified' : null;
}

// ---- section 9: JSON edits -------------------------------------------------

/** Validate one edit object and turn it into an Edit, or null when malformed. */
function jsonToEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const mustExist = (tree: Tree): string => {
    demandSafe(p);
    const t = tree.current(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      demandSafe(p);
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      tree.put(p, text); // byte for byte
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = mustExist(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const hay = toLf(before);
      const needle = toLf(oldStr);
      let hits = 0;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) hits++;
      if (hits === 0) throw new EditFail('no-match', p);
      if (hits > 1) throw new EditFail('ambiguous', p);
      const at = hay.indexOf(needle);
      const joined = hay.slice(0, at) + toLf(newStr) + hay.slice(at + needle.length);
      tree.put(p, crlf ? joined.replaceAll('\n', '\r\n') : joined);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line;
    const addLines = patchLines(o.new_str);
    return (tree) => {
      const body = dissect(mustExist(tree));
      if (atLine < 0 || atLine > body.lines.length) throw new EditFail('no-match', p);
      const lines = [...body.lines];
      lines.splice(atLine, 0, ...addLines);
      tree.put(p, assemble(lines, body.eol, body.endsWithEol));
    };
  }

  return null;
}

function readJsonEdits(text: string, lines: string[]): Edit[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${firstIdx + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${firstIdx + 1}`);
    const edits: Edit[] = [];
    for (const item of parsed) {
      const e = jsonToEdit(item);
      if (e === null) throw new Exit2(`error: parse ${firstIdx + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonToEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 6: unified diffs ----------------------------------------------

interface HunkRow {
  tag: 'ctx' | 'del' | 'add' | 'note';
  text: string;
  bare: boolean; // true when the row came from a truly empty patch line
}

interface Hunk {
  start: number; // the A of @@ -A[,B] +C[,D] @@
  rows: HunkRow[];
}

interface DiffSection {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  makeNew: boolean;
  makeDeleted: boolean;
  hunks: Hunk[];
}

function newDiffSection(): DiffSection {
  return {
    gitOld: null,
    gitNew: null,
    minusPath: null,
    plusPath: null,
    renameFrom: null,
    renameTo: null,
    makeNew: false,
    makeDeleted: false,
    hunks: [],
  };
}

/** Path from a --- / +++ header line: up to the first tab, trimmed, a/ or b/ stripped. */
function headerPath(raw: string): string {
  const tab = raw.indexOf('\t');
  const t = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

/** Does a `\` row follow the hunk's last context or + row? */
function noteAfterLastWritten(h: Hunk): boolean {
  for (let i = h.rows.length - 1; i >= 0; i--) {
    const t = h.rows[i]!.tag;
    if (t === 'ctx' || t === 'add') {
      return i + 1 < h.rows.length && h.rows[i + 1]!.tag === 'note';
    }
  }
  return false;
}

function readUnified(lines: string[], strict: boolean): Edit[] {
  const sections: DiffSection[] = [];
  let sec: DiffSection | null = null;
  let i = 0;

  const pairAt = (k: number): boolean =>
    (lines[k] ?? '').startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newDiffSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i++;
      continue;
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { start: parseInt(m[1]!, 10), rows: [] };
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairAt(j)) break;
        if (b === '') {
          hunk.rows.push({ tag: 'ctx', text: '', bare: true });
          j++;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') hunk.rows.push({ tag: 'ctx', text: b.slice(1), bare: false });
        else if (c === '-') hunk.rows.push({ tag: 'del', text: b.slice(1), bare: false });
        else if (c === '+') hunk.rows.push({ tag: 'add', text: b.slice(1), bare: false });
        else if (c === '\\') hunk.rows.push({ tag: 'note', text: '', bare: false });
        else break;
        j++;
      }
      while (hunk.rows.length > 0) {
        const last = hunk.rows[hunk.rows.length - 1]!;
        if (last.tag === 'ctx' && last.bare) hunk.rows.pop();
        else break;
      }
      sec.hunks.push(hunk);
      i = j;
      continue;
    }

    if (line.startsWith('--- ')) {
      if (pairAt(i)) {
        if (sec === null || sec.minusPath !== null || sec.hunks.length > 0) {
          sec = newDiffSection();
          sections.push(sec);
        }
        sec.minusPath = headerPath(line.slice(4));
        sec.plusPath = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (sec !== null && sec.hunks.length === 0) {
        // a --- line inside a section header with no +++ after it
        throw new Exit2(`error: parse ${i + 2}`);
      }
      i++;
      continue;
    }

    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) sec.makeNew = true;
      else if (line.startsWith('deleted file mode')) sec.makeDeleted = true;
      // every other header line is ignored
    }
    i++;
  }

  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: DiffSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.minusPath ?? sec.renameFrom ?? sec.gitOld;
    const newPath = sec.plusPath ?? sec.renameTo ?? sec.gitNew;
    const isCreate = sec.makeNew || oldPath === '/dev/null';
    const isDelete = sec.makeDeleted || newPath === '/dev/null';

    if (isCreate) {
      const target = newPath ?? '';
      demandSafe(target);
      if (tree.current(target) !== null) throw new EditFail('exists', target);
      const content: string[] = [];
      let lastAddNoted = false;
      for (const h of sec.hunks) {
        h.rows.forEach((r, idx) => {
          if (r.tag === 'add') {
            content.push(r.text);
            lastAddNoted = idx + 1 < h.rows.length && h.rows[idx + 1]!.tag === 'note';
          }
        });
      }
      tree.put(target, createText(content, !lastAddNoted));
      return;
    }

    if (isDelete) {
      const target = oldPath ?? '';
      demandSafe(target);
      if (tree.current(target) === null) throw new EditFail('missing', target);
      tree.put(target, null);
      return;
    }

    const from = oldPath ?? '';
    const to = newPath ?? from;
    demandSafe(from);
    if (to !== from) demandSafe(to);
    const beforeText = tree.current(from);
    if (beforeText === null) throw new EditFail('missing', from);
    if (to !== from && tree.current(to) !== null) throw new EditFail('exists', to);

    const body = dissect(beforeText);
    let work = [...body.lines];
    let finalBreak = body.endsWithEol;
    let drift = 0; // sum of (new length - old length) over hunks applied so far

    for (const h of sec.hunks) {
      const kinds: string[] = [];
      const oldLines: string[] = [];
      const addTexts: string[] = [];
      for (const r of h.rows) {
        if (r.tag === 'note') continue;
        kinds.push(r.tag);
        if (r.tag === 'add') addTexts.push(r.text);
        else oldLines.push(r.text);
      }
      const newLen = kinds.filter((k) => k !== 'del').length;

      if (oldLines.length === 0) {
        let at = h.start + drift;
        if (at < 0) at = 0;
        if (at > work.length) at = work.length;
        const touchesEnd = at === work.length;
        work = [...work.slice(0, at), ...addTexts, ...work.slice(at)];
        if (touchesEnd) finalBreak = !noteAfterLastWritten(h);
        drift += addTexts.length;
        continue;
      }

      const hit = locate(work, oldLines, 0, strict);
      if (hit === null) throw new EditFail('no-match', from);
      const targetPos = h.start - 1 + drift;
      let best = hit.starts[0]!;
      for (const s of hit.starts) {
        if (Math.abs(s - targetPos) < Math.abs(best - targetPos)) best = s;
      }
      const segment = work.slice(best, best + oldLines.length);
      const repl = replacementFor(kinds, addTexts, segment, best, oldLines[0]!, hit.tier);
      const touchesEnd = best + oldLines.length === work.length;
      work = [...work.slice(0, best), ...repl, ...work.slice(best + oldLines.length)];
      if (touchesEnd) finalBreak = !noteAfterLastWritten(h);
      drift += newLen - oldLines.length;
    }

    tree.put(to, assemble(work, body.eol, finalBreak));
    if (to !== from) {
      tree.put(from, null);
      tree.moves.push({ from, to });
    }
  };
}

// ---- section 7: SEARCH/REPLACE blocks ---------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function readSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0; // blocks are looked for at or after this line
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;

    // the path: nearest earlier non-blank, non-fence line since the last block
    let path: string | null = null;
    for (let k = searchLine - 1; k >= searchFrom; k--) {
      const cand = lines[k]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);

    let sep = -1;
    for (let k = searchLine + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let k = sep + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);

    blocks.push({
      path,
      oldLines: lines.slice(searchLine + 1, sep),
      newLines: lines.slice(sep + 1, end),
    });
    prevPath = path;
    searchFrom = end + 1;
    i = end + 1;
  }

  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(block: SrBlock, strict: boolean): Edit {
  return (tree) => {
    demandSafe(block.path);
    if (block.oldLines.length === 0) {
      if (tree.current(block.path) !== null) throw new EditFail('exists', block.path);
      tree.put(block.path, createText(block.newLines));
      return;
    }
    const beforeText = tree.current(block.path);
    if (beforeText === null) throw new EditFail('missing', block.path);
    const body = dissect(beforeText);
    const hit = locate(body.lines, block.oldLines, 0, strict);
    if (hit === null) throw new EditFail('no-match', block.path);
    if (hit.starts.length > 1) throw new EditFail('ambiguous', block.path);
    const at = hit.starts[0]!;
    const segment = body.lines.slice(at, at + block.oldLines.length);
    const repl = reindentList(block.newLines, segment[0] ?? '', block.oldLines[0]!, hit.tier);
    const work = [...body.lines.slice(0, at), ...repl, ...body.lines.slice(at + block.oldLines.length)];
    tree.put(block.path, assemble(work, body.eol, body.endsWithEol));
  };
}

// ---- section 8: V4A patches --------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  kinds: string[]; // 'ctx' | 'del' | 'add', in body order
  bare: boolean[]; // parallel to kinds: the row came from a truly empty patch line
  oldLines: string[];
  addTexts: string[];
  toEof: boolean;
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  headerLine: number; // 1-based, for parse errors
  addLines: string[]; // for 'add'
  moveTo: string | null; // for 'upd'
  chunks: V4aChunk[]; // for 'upd'
}

function readV4a(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  let chunk: V4aChunk | null = null;

  const startChunk = (anchor: string | null): V4aChunk => {
    const c: V4aChunk = { anchor, kinds: [], bare: [], oldLines: [], addTexts: [], toEof: false };
    cur!.chunks.push(c);
    return c;
  };

  // blank lines at the end of an update section are not part of it: drop the
  // trailing context rows of its last chunk that came from empty patch lines
  const closeUpdate = (s: V4aSection | null): void => {
    if (s === null || s.kind !== 'upd' || s.chunks.length === 0) return;
    const last = s.chunks[s.chunks.length - 1]!;
    while (last.kinds.length > 0) {
      const k = last.kinds.length - 1;
      if (last.kinds[k] === 'ctx' && last.bare[k]) {
        last.kinds.pop();
        last.bare.pop();
        last.oldLines.pop();
      } else break;
    }
  };

  for (let idx = firstIdx + 1; idx < lastIdx; idx++) {
    const line = lines[idx]!;
    const lineNo = idx + 1;

    if (line.startsWith('*** Add File: ')) {
      closeUpdate(cur);
      cur = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), headerLine: lineNo, addLines: [], moveTo: null, chunks: [] };
      sections.push(cur);
      chunk = null;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      closeUpdate(cur);
      cur = { kind: 'del', path: line.slice('*** Delete File: '.length).trim(), headerLine: lineNo, addLines: [], moveTo: null, chunks: [] };
      sections.push(cur);
      chunk = null;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      closeUpdate(cur);
      cur = { kind: 'upd', path: line.slice('*** Update File: '.length).trim(), headerLine: lineNo, addLines: [], moveTo: null, chunks: [] };
      sections.push(cur);
      chunk = null;
      continue;
    }

    if (cur === null) {
      if (isBlank(line)) continue;
      throw new Exit2(`error: parse ${lineNo}`);
    }

    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push(line.slice(1));
      else if (line === '') cur.addLines.push('');
      else throw new Exit2(`error: parse ${lineNo}`);
      continue;
    }

    if (cur.kind === 'del') {
      // a Delete File section has no lines; blanks before the next section are not part of it
      if (isBlank(line)) continue;
      throw new Exit2(`error: parse ${lineNo}`);
    }

    // update section
    const bodySoFar = cur.chunks.length > 0 || cur.moveTo !== null;
    if (line.startsWith('*** Move to: ') && !bodySoFar && chunk === null) {
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      const anchorText = line.slice(2).trim();
      chunk = startChunk(anchorText === '' ? null : anchorText);
      continue;
    }
    if (line === '*** End of File') {
      if (chunk === null) chunk = startChunk(null);
      chunk.toEof = true;
      chunk = null;
      continue;
    }
    const c0 = line === '' ? ' ' : line[0]!;
    if (c0 === ' ' || c0 === '-' || c0 === '+') {
      if (chunk === null) chunk = startChunk(null);
      const text = line === '' ? '' : line.slice(1);
      if (c0 === ' ') {
        chunk.kinds.push('ctx');
        chunk.bare.push(line.trim() === '');
        chunk.oldLines.push(text);
      } else if (c0 === '-') {
        chunk.kinds.push('del');
        chunk.bare.push(false);
        chunk.oldLines.push(text);
      } else {
        chunk.kinds.push('add');
        chunk.bare.push(false);
        chunk.addTexts.push(text);
      }
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  closeUpdate(cur);

  // trailing blank lines of an Add section are not part of it
  for (const s of sections) {
    if (s.kind === 'add') {
      while (s.addLines.length > 0 && s.addLines[s.addLines.length - 1] === '') s.addLines.pop();
    }
    if (s.kind === 'upd' && s.chunks.length === 0 && s.moveTo === null) {
      throw new Exit2(`error: parse ${s.headerLine}`);
    }
  }

  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    demandSafe(sec.path);

    if (sec.kind === 'add') {
      if (tree.current(sec.path) !== null) throw new EditFail('exists', sec.path);
      tree.put(sec.path, createText(sec.addLines));
      return;
    }

    if (sec.kind === 'del') {
      if (tree.current(sec.path) === null) throw new EditFail('missing', sec.path);
      tree.put(sec.path, null);
      return;
    }

    // update, possibly with a move
    const dest = sec.moveTo;
    if (dest !== null) demandSafe(dest);
    const beforeText = tree.current(sec.path);
    if (beforeText === null) throw new EditFail('missing', sec.path);
    if (dest !== null && tree.current(dest) !== null) throw new EditFail('exists', dest);

    const body = dissect(beforeText);
    let work = [...body.lines];
    let cursor = 0;

    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const anchorHit = locateOne(work, ch.anchor, cursor, strict);
        if (anchorHit === null) throw new EditFail('no-match', sec.path);
        cursor = anchorHit.starts[0]! + 1;
      }

      if (ch.oldLines.length === 0) {
        const at = ch.toEof ? work.length : Math.min(cursor, work.length);
        work = [...work.slice(0, at), ...ch.addTexts, ...work.slice(at)];
        cursor = at + ch.addTexts.length;
        continue;
      }

      const hit = locate(work, ch.oldLines, cursor, strict);
      let at = -1;
      let tier = 0;
      if (hit !== null) {
        tier = hit.tier;
        for (const s of hit.starts) {
          if (!ch.toEof || s + ch.oldLines.length === work.length) {
            at = s;
            break;
          }
        }
      }
      if (at < 0) throw new EditFail('no-match', sec.path);
      const segment = work.slice(at, at + ch.oldLines.length);
      const repl = replacementFor(ch.kinds, ch.addTexts, segment, at, ch.oldLines[0]!, tier);
      work = [...work.slice(0, at), ...repl, ...work.slice(at + ch.oldLines.length)];
      cursor = at + repl.length;
    }

    const outText = assemble(work, body.eol, body.endsWithEol);
    if (dest !== null) {
      tree.put(dest, outText);
      tree.put(sec.path, null);
      tree.moves.push({ from: sec.path, to: dest });
    } else {
      tree.put(sec.path, outText);
    }
  };
}

// ---- sections 1, 2 and 10: the command line, reporting, atomic write -------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsDone = false;

  for (const a of args) {
    if (!optionsDone && a === '--') {
      optionsDone = true;
    } else if (!optionsDone && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchPath = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = readJsonEdits(patchText, lines);
    else if (kind === 'unified') edits = readUnified(lines, strict);
    else if (kind === 'search-replace') edits = readSearchReplace(lines, strict);
    else edits = readV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  // Apply every edit in order; a failed edit rolls back and is reported,
  // and the edits after it still run so all failures surface.
  const tree = new Tree();
  const failures: EditFail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.state);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.state.clear();
      for (const [k, v] of snapshot) tree.state.set(k, v);
      tree.moves.length = moveCount;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [
        ...failures.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${failures.length} of ${edits.length} edits`,
      ],
    };
  }

  // Report lines: one per changed path, byte order; a qualifying move pair
  // collapses into a single R line that sorts by the new path.
  interface ReportRow {
    sortKey: string;
    text: string;
  }
  const rows: ReportRow[] = [];
  const moveCovered = new Set<string>();
  for (const mv of tree.moves) {
    const wasThere = tree.original(mv.from) !== null;
    const goneNow = tree.current(mv.from) === null;
    const freshThere = tree.original(mv.to) === null;
    const thereNow = tree.current(mv.to) !== null;
    if (wasThere && goneNow && freshThere && thereNow && !moveCovered.has(mv.from) && !moveCovered.has(mv.to)) {
      rows.push({ sortKey: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      moveCovered.add(mv.from);
      moveCovered.add(mv.to);
    }
  }
  for (const p of tree.state.keys()) {
    if (moveCovered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.state.get(p)!;
    if (was === now) continue;
    rows.push({ sortKey: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));

  if (!checkOnly) {
    for (const p of tree.state.keys()) {
      const was = tree.original(p);
      const now = tree.state.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
