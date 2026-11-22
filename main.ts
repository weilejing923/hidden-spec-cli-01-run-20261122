// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}


// ---------- file lines ----------
interface FileParts { lines: string[]; br: string; final: boolean }
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}
// ---------- tier matching (section 5) ----------
const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => s.match(/^[ \t]*/)![0];
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return trimST(a) === trimST(b);
}
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) if (!tierEq(lines[i + j]!, O[j]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
interface Found { tier: number; positions: number[] }
function findTiers(lines: string[], O: string[], strict: boolean, from = 0): Found | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, O, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}
function reindent(line: string, tier: number, O: string[], fileFirst: string): string {
  if (tier !== 2 || O.length === 0) return line;
  if (line === '' || line.trim() === '') return line;
  const P = leadST(O[0]!); const F = leadST(fileFirst);
  return line.startsWith(P) ? F + line.slice(P.length) : line;
}
interface BodyItem { kind: 'ctx' | 'old' | 'new'; text: string; slash: boolean }
function buildReplacement(body: BodyItem[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const out: string[] = [];
  let oi = 0;
  for (const it of body) {
    if (it.kind === 'ctx') { out.push(fileLines[pos + oi]!); oi++; }
    else if (it.kind === 'old') { oi++; }
    else out.push(reindent(it.text, tier, O, fileLines[pos] ?? ''));
  }
  return out;
}
function lastCtxNewSlash(body: BodyItem[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') return body[i]!.slash;
  }
  return false;
}
function checkSafe(p: string): void { if (!safe(p)) throw new Fail('unsafe', p); }
function getFile(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

// ---------- unified (section 6) ----------
interface Hunk { a: number; body: BodyItem[] }
interface Section { oldPath: string | null; newPath: string | null; creation: boolean; deletion: boolean; hunks: Hunk[]; rf: string | null; rt: string | null; go: string | null; gn: string | null }
function stripPrefix(p: string): string { return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p; }
function headerPath(rest: string): string {
  const tab = rest.indexOf('\t');
  return stripPrefix((tab >= 0 ? rest.slice(0, tab) : rest).trim());
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHasPair = false; let curRenameFrom: string | null = null; let curRenameTo: string | null = null;
  let gitOld: string | null = null; let gitNew: string | null = null;
  let i = 0;
  const newSection = (): Section => { const sec: Section = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [], rf: null, rt: null, go: null, gn: null }; sections.push(sec); cur = sec; curHasPair = false; curRenameFrom = null; curRenameTo = null; gitOld = null; gitNew = null; return sec; };
  const isPairAt = (k: number): boolean => (lines[k] ?? '').startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const line = lines[i]!; const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${ln}`);
      { const sec = newSection(); sec.go = m[1]!; sec.gn = m[2]!; gitOld = m[1]!; gitNew = m[2]!; }
      i++; continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new Exit2(`error: parse ${ln}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${ln}`);
      const rest = line.slice(m[0].length);
      if (rest !== '' && !rest.startsWith(' ')) throw new Exit2(`error: parse ${ln}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(hunk);
      i++;
      // body
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (isPairAt(i)) break;
        if (bl === '') { hunk.body.push({ kind: 'ctx', text: '', slash: false }); i++; continue; }
        const c = bl[0]!;
        if (c === ' ') { hunk.body.push({ kind: 'ctx', text: bl.slice(1), slash: false }); i++; continue; }
        if (c === '-') { hunk.body.push({ kind: 'old', text: bl.slice(1), slash: false }); i++; continue; }
        if (c === '+') { hunk.body.push({ kind: 'new', text: bl.slice(1), slash: false }); i++; continue; }
        if (c === '\\') { if (hunk.body.length > 0) hunk.body[hunk.body.length - 1]!.slash = true; i++; continue; }
        break;
      }
      while (hunk.body.length > 0) { const last = hunk.body[hunk.body.length - 1]!; if (last.kind === 'ctx' && last.text === '') hunk.body.pop(); else break; }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (isPairAt(i)) {
        if (!cur || cur.hunks.length > 0 || curHasPair) { newSection(); }
        cur!.oldPath = headerPath(line.slice(4)); cur!.newPath = headerPath(lines[i + 1]!.slice(4)); curHasPair = true;
        i += 2; continue;
      }
      if (cur && cur.hunks.length === 0) throw new Exit2(`error: parse ${ln + 1}`);
      i++; continue;
    }
    // header lines within a section before first hunk
    if (cur && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) { curRenameFrom = line.slice(12).trim(); cur.rf = curRenameFrom; }
      else if (line.startsWith('rename to ')) { curRenameTo = line.slice(10).trim(); cur.rt = curRenameTo; }
      else if (line.startsWith('new file mode')) cur.creation = true;
      else if (line.startsWith('deleted file mode')) cur.deletion = true;
    }
    i++;
  }
  // sections that ended without further header lines need stored git/rename too: handle in edit via any fields with fallback
  const edits: Edit[] = [];
  for (const sec of sections) {
    const rf = sec.rf; const rt = sec.rt;
    const go = sec.go; const gn = sec.gn;
    let oldP = sec.oldPath; let newP = sec.newPath;
    if (oldP === null && rf != null) oldP = rf;
    if (newP === null && rt != null) newP = rt;
    if (oldP === null && go != null) oldP = go;
    if (newP === null && gn != null) newP = gn;
    // Also: if section started by diff --git and no header lines were scanned after (immediately hunk), _go unset; recover: hunks-only sections keep git paths unknown -> treat old=new=null below
    const isCreate = sec.creation || oldP === '/dev/null';
    const isDelete = sec.deletion || newP === '/dev/null';
    const o = oldP; const n = newP;
    edits.push((tree) => {
      if (isCreate) {
        const np = n; if (np === null) throw new Fail('missing', '');
        checkSafe(np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = []; let slash = false;
        for (const h of sec.hunks) for (const it of h.body) if (it.kind === 'new') { plus.push(it.text); slash = it.slash; }
        tree.now.set(np, joinFile(plus, '\n', plus.length === 0 ? false : !slash));
        return;
      }
      if (isDelete) {
        const op = o; if (op === null) throw new Fail('missing', '');
        checkSafe(op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const op = o; const np = n ?? o;
      if (op === null || np === null) throw new Fail('missing', op ?? '');
      checkSafe(op); if (np !== op) checkSafe(np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (np !== op && tree.get(np) !== null) throw new Fail('exists', np);
      const parts = splitFile(before);
      const fl = [...parts.lines]; let fin = parts.final; let d = 0;
      for (const h of sec.hunks) {
        const O = h.body.filter((b) => b.kind !== 'new').map((b) => b.text);
        const Nlen = h.body.filter((b) => b.kind !== 'old').length;
        if (O.length === 0) {
          const add = h.body.filter((b) => b.kind === 'new').map((b) => b.text);
          let at = h.a + d; if (at < 0) at = 0; if (at > fl.length) at = fl.length;
          const atEnd = at === fl.length;
          fl.splice(at, 0, ...add);
          if (atEnd && add.length > 0) fin = !lastCtxNewSlash(h.body);
          d += add.length;
        } else {
          const f = findTiers(fl, O, strict);
          if (!f) throw new Fail('no-match', op);
          const target = h.a - 1 + d;
          let best = f.positions[0]!; let bd = Math.abs(best - target);
          for (const pos of f.positions) { const dd = Math.abs(pos - target); if (dd < bd) { bd = dd; best = pos; } }
          const repl = buildReplacement(h.body, fl, best, f.tier, O);
          const toEnd = best + O.length === fl.length;
          fl.splice(best, O.length, ...repl);
          if (toEnd) fin = !lastCtxNewSlash(h.body);
          d += Nlen - O.length;
        }
      }
      const out = joinFile(fl, parts.br, fin);
      if (np !== op) { tree.now.set(op, null); tree.now.set(np, out); tree.moves.push([op, np]); }
      else tree.now.set(np, out);
    });
  }
  return edits;
}

// ---------- SEARCH/REPLACE (section 7) ----------
function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block { path: string; oldL: string[]; newL: string[] }
  const blocks: Block[] = [];
  let prevEnd = 0; let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    // path
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim(); break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let sep = -1; let rep = -1;
    for (let k = s + 1; k < lines.length; k++) if (lines[k]!.trimEnd() === '=======') { sep = k; break; }
    if (sep >= 0) for (let k = sep + 1; k < lines.length; k++) if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
    if (sep < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldL: lines.slice(s + 1, sep), newL: lines.slice(sep + 1, rep) });
    prevPath = path; prevEnd = rep + 1; i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    checkSafe(b.path);
    if (b.oldL.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinFile([...b.newL], '\n', b.newL.length > 0));
      return;
    }
    const before = getFile(tree, b.path);
    const parts = splitFile(before);
    const f = findTiers(parts.lines, b.oldL, strict);
    if (!f) throw new Fail('no-match', b.path);
    if (f.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = f.positions[0]!;
    const repl = b.newL.map((l) => reindent(l, f.tier, b.oldL, parts.lines[pos] ?? ''));
    const fl = [...parts.lines]; fl.splice(pos, b.oldL.length, ...repl);
    tree.now.set(b.path, joinFile(fl, parts.br, parts.final));
  });
}

// ---------- V4A (section 8) ----------
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1; for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Chunk { anchor: string | null; body: BodyItem[]; eof: boolean }
  interface VSec { kind: 'add' | 'del' | 'upd'; path: string; line: number; raw: string[]; rawIdx: number[] }
  const secs: VSec[] = [];
  let cur: VSec | null = null;
  for (let k = first + 1; k < last; k++) {
    const l = lines[k]!;
    let kind: VSec['kind'] | null = null; let path = '';
    if (l.startsWith('*** Add File: ')) { kind = 'add'; path = l.slice(14).trim(); }
    else if (l.startsWith('*** Delete File: ')) { kind = 'del'; path = l.slice(17).trim(); }
    else if (l.startsWith('*** Update File: ')) { kind = 'upd'; path = l.slice(17).trim(); }
    if (kind) { cur = { kind, path, line: k + 1, raw: [], rawIdx: [] }; secs.push(cur); continue; }
    if (!cur) { if (blank(l)) continue; throw new Exit2(`error: parse ${k + 1}`); }
    cur.raw.push(l); cur.rawIdx.push(k + 1);
  }
  const edits: Edit[] = [];
  for (const sec of secs) {
    const raw = [...sec.raw]; const rawIdx = [...sec.rawIdx];
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) { raw.pop(); rawIdx.pop(); }
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      raw.forEach((l, j) => {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${rawIdx[j]}`);
      });
      edits.push((tree) => {
        checkSafe(sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, joinFile(fileLines, '\n', fileLines.length > 0));
      });
    } else if (sec.kind === 'del') {
      raw.forEach((l, j) => { if (!blank(l)) throw new Exit2(`error: parse ${rawIdx[j]}`); });
      edits.push((tree) => {
        checkSafe(sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      });
    } else {
      let moveTo: string | null = null; let start = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) { moveTo = raw[0]!.slice(13).trim(); start = 1; }
      const chunks: Chunk[] = [];
      let cc: Chunk | null = null;
      for (let j = start; j < raw.length; j++) {
        const l = raw[j]!;
        if (l === '*** End of File') {
          if (!cc) { cc = { anchor: null, body: [], eof: true }; chunks.push(cc); }
          cc.eof = true; cc = null; continue;
        }
        if (l.startsWith('@@')) {
          const anch = l.slice(2).trim();
          cc = { anchor: anch === '' ? null : anch, body: [], eof: false }; chunks.push(cc); continue;
        }
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${rawIdx[j]}`);
        const c = l === '' ? ' ' : l[0]!;
        if (c !== ' ' && c !== '-' && c !== '+') throw new Exit2(`error: parse ${rawIdx[j]}`);
        if (!cc) { cc = { anchor: null, body: [], eof: false }; chunks.push(cc); }
        cc.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: l === '' ? '' : l.slice(1), slash: false });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
      const mv = moveTo;
      edits.push((tree) => {
        checkSafe(sec.path); if (mv !== null) checkSafe(mv);
        const before = tree.get(sec.path);
        if (before === null) throw new Fail('missing', sec.path);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const parts = splitFile(before);
        const fl = [...parts.lines];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let found = -1;
            const max = strict ? 0 : 2;
            for (let t = 0; t <= max && found < 0; t++) for (let k = cursor; k < fl.length; k++) if (tierEq(fl[k]!, ch.anchor, t)) { found = k; break; }
            if (found < 0) throw new Fail('no-match', sec.path);
            cursor = found + 1;
          }
          const O = ch.body.filter((b) => b.kind !== 'new').map((b) => b.text);
          if (O.length === 0) {
            const add = ch.body.filter((b) => b.kind === 'new').map((b) => b.text);
            const at = ch.eof ? fl.length : Math.min(cursor, fl.length);
            fl.splice(at, 0, ...add);
            cursor = at + add.length;
          } else {
            let chosen: Found | null = null; let pos = -1;
            const max = strict ? 0 : 2;
            for (let t = 0; t <= max; t++) {
              const ps = occurrences(fl, O, t, cursor).filter((pp) => !ch.eof || pp + O.length === fl.length);
              if (ps.length > 0) { chosen = { tier: t, positions: ps }; pos = ps[0]!; break; }
            }
            if (!chosen || pos < 0) throw new Fail('no-match', sec.path);
            const repl = buildReplacement(ch.body, fl, pos, chosen.tier, O);
            fl.splice(pos, O.length, ...repl);
            cursor = pos + repl.length;
          }
        }
        const out = joinFile(fl, parts.br, parts.final);
        if (mv !== null) { tree.now.set(sec.path, null); tree.now.set(mv, out); tree.moves.push([sec.path, mv]); }
        else tree.now.set(sec.path, out);
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const used = new Set<string>();
  const keyed: Array<{ key: string; line: string }> = [];
  for (const [o, n] of tree.moves) {
    if (used.has(o) || used.has(n)) continue;
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) != null) {
      keyed.push({ key: n, line: `R ${o} -> ${n}` }); used.add(o); used.add(n);
    }
  }
  for (const p of changed) {
    if (used.has(p)) continue;
    const was = tree.original(p); const now = tree.now.get(p)!;
    keyed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = keyed.map((k) => k.line);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
