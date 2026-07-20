import zlib from 'node:zlib';

import {
  PDFDocument,
  PDFRawStream,
  PDFDict,
  PDFArray,
  PDFName,
  PDFRef,
} from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';

import {
  CATEGORY,
  CATEGORY_ORDER,
} from './analyzeTypes.js';
import type {
  Category,
  Align,
  Args,
  CategoryBucket,
  StreamRecord,
  OpGroupName,
  OpGroups,
  OpCounts,
  OperatorSummary,
  Report,
} from './analyzeTypes.js';

// ---------------------------------------------------------------------------
// Interned names
// ---------------------------------------------------------------------------
const N_TYPE = PDFName.of('Type');
const N_SUBTYPE = PDFName.of('Subtype');
const N_FILTER = PDFName.of('Filter');
const N_CONTENTS = PDFName.of('Contents');
const N_METADATA = PDFName.of('Metadata');
const N_OBJSTM = PDFName.of('ObjStm');
const N_XREF = PDFName.of('XRef');
const N_IMAGE = PDFName.of('Image');
const N_FORM = PDFName.of('Form');
const N_THUMB = PDFName.of('Thumb');
const FONTFILE_KEYS = [PDFName.of('FontFile'), PDFName.of('FontFile2'), PDFName.of('FontFile3')];

// ---------------------------------------------------------------------------
// Operator groups
// ---------------------------------------------------------------------------

// Grouped PDF content operators we care about for the "real text vs. vector
// outlines" verdict. Path-construction + fill/stroke ops dominate a document
// whose glyphs were converted to outlines; text-showing ops dominate one with
// real, selectable text.
const OP_GROUPS: Record<OpGroupName, string[]> = {
  path: ['m', 'l', 'c', 'v', 'y', 're', 'h'],
  paint: ['f', 'f*', 'F', 'S', 's', 'B', 'B*', 'b', 'b*'],
  textShow: ['Tj', 'TJ', "'", '"'],
  textObj: ['BT'],
  xobject: ['Do'],
  inlineImage: ['BI'],
};
const TRACKED_OPS = new Set<string>(Object.values(OP_GROUPS).flat());

export class AnalyzeHelpers {
  /**
   * Walk every indirect object, attribute each stream's bytes to a role, and
   * accumulate per-category totals plus a content-stream operator profile.
   */
  static analyze(doc: PDFDocument, bytes: Uint8Array, args: Args): Report {
    const ctx = doc.context;
    const roles = AnalyzeHelpers.buildRoleMap(ctx);

    const categories = new Map<Category, CategoryBucket>(
      CATEGORY_ORDER.map((name) => [name, { name, count: 0, raw: 0, decoded: 0 }]),
    );
    const streams: StreamRecord[] = [];
    let nonStreamObjects = 0;
    let streamRawTotal = 0;

    const decodeBudget = args.maxDecodeMb * 1024 * 1024;
    let decodedScanned = 0;
    let scanTruncated = false;
    const ops: OpCounts = Object.create(null);

    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) {
        nonStreamObjects++;
        continue;
      }

      const dict = obj.dict;
      const category = AnalyzeHelpers.classify(ref, dict, roles);
      const raw = obj.contents.length;
      streamRawTotal += raw;

      const filters = AnalyzeHelpers.filterNames(dict);
      const decoded = AnalyzeHelpers.decodedLength(obj.contents, filters);

      const bucket = categories.get(category)!;
      bucket.count++;
      bucket.raw += raw;
      bucket.decoded += decoded ?? raw;

      streams.push({
        ref: ref.toString(),
        category,
        raw,
        decoded,
        filter: filters.length ? filters.join('+') : '(none)',
      });

      // Operator profile: only for content streams, only while under budget.
      if (category === CATEGORY.CONTENT && decoded != null && decodedScanned < decodeBudget) {
        const text = AnalyzeHelpers.decodedBytes(obj.contents, filters);
        if (text) {
          decodedScanned += text.length;
          AnalyzeHelpers.countOperators(text.toString('latin1'), ops);
        }
      } else if (category === CATEGORY.CONTENT && decodedScanned >= decodeBudget) {
        scanTruncated = true;
      }
    }

    streams.sort((a, b) => b.raw - a.raw);

    return {
      file: args.input,
      fileBytes: bytes.length,
      pdfVersion: AnalyzeHelpers.headerVersion(bytes),
      linearized: AnalyzeHelpers.isLinearized(bytes),
      pageCount: AnalyzeHelpers.safe(() => doc.getPageCount(), null),
      objectCount: nonStreamObjects + streams.length,
      streamCount: streams.length,
      nonStreamObjects,
      // Everything that is not raw stream payload: dict text, xref, whitespace.
      structuralOverhead: Math.max(0, bytes.length - streamRawTotal),
      categories: CATEGORY_ORDER.map((name) => categories.get(name)!).filter((c) => c.count > 0),
      largestStreams: streams.slice(0, args.top),
      operators: AnalyzeHelpers.summarizeOperators(ops),
      scan: { decodedScanned, truncated: scanTruncated, budgetMb: args.maxDecodeMb },
    };
  }

  /**
   * Tag indirect objects with a role that is only knowable from their parent.
   * Content streams and font programs carry no /Type of their own, so we discover
   * them by following /Contents and /FontFile* references from other objects.
   */
  static buildRoleMap(ctx: PDFContext): Map<string, string> {
    const roles = new Map<string, string>();
    const tag = (v: PDFObject | undefined, role: string): void => {
      if (v instanceof PDFRef) roles.set(v.toString(), role);
    };
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
      if (!dict) continue;

      const contents = dict.get(N_CONTENTS);
      if (contents instanceof PDFRef) tag(contents, 'content');
      if (contents instanceof PDFArray) {
        for (let i = 0; i < contents.size(); i++) tag(contents.get(i), 'content');
      }
      for (const key of FONTFILE_KEYS) tag(dict.get(key), 'fontfile');
      tag(dict.get(N_THUMB), 'thumb');
    }
    return roles;
  }

  /** Assign one category to a stream from its own dict plus the role map. */
  static classify(ref: PDFRef, dict: PDFDict, roles: Map<string, string>): Category {
    const subtype = dict.get(N_SUBTYPE);
    if (subtype === N_IMAGE) return CATEGORY.IMAGE;
    if (subtype === N_FORM) return CATEGORY.FORM;

    const role = roles.get(ref.toString());
    if (role === 'fontfile') return CATEGORY.FONT;
    if (role === 'thumb') return CATEGORY.IMAGE;

    const type = dict.get(N_TYPE);
    if (type === N_METADATA) return CATEGORY.METADATA;
    if (type === N_OBJSTM) return CATEGORY.OBJSTM;
    if (type === N_XREF) return CATEGORY.XREF;

    if (role === 'content') return CATEGORY.CONTENT;
    return CATEGORY.OTHER;
  }

  /** Filter names for a stream dict, as plain strings (handles name or array). */
  static filterNames(dict: PDFDict): string[] {
    const f = dict.get(N_FILTER);
    if (f instanceof PDFName) return [f.decodeText()];
    if (f instanceof PDFArray) {
      const out: string[] = [];
      for (let i = 0; i < f.size(); i++) {
        const el = f.get(i);
        if (el instanceof PDFName) out.push(el.decodeText());
      }
      return out;
    }
    return [];
  }

  /**
   * Decoded bytes for a stream, or null when we can't cheaply decode it here.
   * Handles the two common cases: stored (no filter) and single-filter
   * FlateDecode. Anything else (DCTDecode, filter chains, LZW, ...) returns null.
   */
  static decodedBytes(raw: Uint8Array, filters: string[]): Buffer | null {
    if (filters.length === 0) return Buffer.from(raw); // stored, already "decoded"
    if (filters.length !== 1 || filters[0] !== 'FlateDecode') return null;
    try {
      return zlib.inflateSync(Buffer.from(raw));
    } catch {
      return null;
    }
  }

  /** Decoded byte length of a stream, or null when we can't cheaply decode it. */
  static decodedLength(raw: Uint8Array, filters: string[]): number | null {
    const buf = AnalyzeHelpers.decodedBytes(raw, filters);
    return buf ? buf.length : null;
  }

  /**
   * Count operator tokens in a decoded content stream. Heuristic: string and hex
   * literals are stripped first so their contents can't masquerade as operators;
   * inline-image binary is not fully parsed, so counts are approximate.
   */
  static countOperators(text: string, acc: OpCounts): void {
    const cleaned = text
      .replace(/\((?:\\.|[^\\()])*\)/gs, ' ') // (string) literals
      .replace(/<[0-9a-fA-F\s]*>/g, ' '); // <hex> literals
    for (const m of cleaned.matchAll(/(?:^|[\s])([A-Za-z'"*]+|f\*|b\*|B\*)(?=[\s]|$)/g)) {
      const op = m[1];
      if (op !== undefined && TRACKED_OPS.has(op)) acc[op] = (acc[op] ?? 0) + 1;
    }
  }

  /** Fold raw operator counts into group totals. */
  static summarizeOperators(ops: OpCounts): OperatorSummary {
    const groups = {} as OpGroups;
    for (const [group, names] of Object.entries(OP_GROUPS) as [OpGroupName, string[]][]) {
      groups[group] = names.reduce((sum, n) => sum + (ops[n] ?? 0), 0);
    }
    return { groups, byOp: ops };
  }

  static headerVersion(bytes: Uint8Array): string {
    const head = Buffer.from(bytes.subarray(0, 16)).toString('latin1');
    const m = head.match(/%PDF-(\d+\.\d+)/);
    return m ? m[1]! : 'unknown';
  }

  static isLinearized(bytes: Uint8Array): boolean {
    const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
    return /\/Linearized/.test(head);
  }

  static printReport(r: Report, args: Args): void {
    const pct = (n: number): string => `${((n / r.fileBytes) * 100).toFixed(1)}%`;

    AnalyzeHelpers.line();
    console.log(`PDF size analysis: ${r.file}`);
    AnalyzeHelpers.line();
    console.log(`  File size        ${AnalyzeHelpers.fmtBytes(r.fileBytes)}`);
    console.log(`  PDF version      ${r.pdfVersion}${r.linearized ? '  (linearized)' : ''}`);
    console.log(`  Pages            ${r.pageCount ?? 'unknown'}`);
    console.log(`  Indirect objects ${r.objectCount}  (${r.streamCount} streams)`);
    console.log('');

    // --- where the bytes live ---
    console.log('Where the bytes live (by stream payload, compressed):');
    console.log('');
    const rows = r.categories.map((c) => [
      c.name,
      String(c.count),
      AnalyzeHelpers.fmtBytes(c.raw),
      pct(c.raw),
      c.decoded ? AnalyzeHelpers.fmtBytes(c.decoded) : '—',
    ]);
    rows.push([
      'Structure (dicts, xref, overhead)',
      String(r.nonStreamObjects),
      AnalyzeHelpers.fmtBytes(r.structuralOverhead),
      pct(r.structuralOverhead),
      '—',
    ]);
    const catAlign: Align[] = ['left', 'right', 'right', 'right', 'right'];
    AnalyzeHelpers.table(['Category', 'Count', 'Compressed', '% file', 'Decoded'], rows, catAlign);
    console.log('');

    // --- content-stream verdict ---
    const g = r.operators.groups;
    const contentCat = r.categories.find((c) => c.name === CATEGORY.CONTENT);
    if (contentCat) {
      console.log('Content-stream composition:');
      console.log('');
      console.log(`  Path-construction ops (m l c v y re h)   ${g.path.toLocaleString()}`);
      console.log(`  Fill / stroke ops (f S B ...)            ${g.paint.toLocaleString()}`);
      console.log(`  Text-showing ops (Tj TJ ' ")             ${g.textShow.toLocaleString()}`);
      console.log(`  Text objects (BT)                        ${g.textObj.toLocaleString()}`);
      console.log(
        `  Image draws (Do) / inline images (BI)    ${g.xobject.toLocaleString()} / ${g.inlineImage.toLocaleString()}`,
      );
      if (r.scan.truncated) {
        console.log(
          `  (operator scan stopped at ${r.scan.budgetMb} MB decoded; counts are a sample)`,
        );
      }
      console.log('');
      console.log(`  → ${AnalyzeHelpers.contentVerdict(r)}`);
      console.log('');
    }

    // --- image summary ---
    AnalyzeHelpers.printImageSummary(r);

    // --- largest individual objects ---
    console.log(`Largest ${r.largestStreams.length} streams:`);
    console.log('');
    const streamAlign: Align[] = ['left', 'left', 'right', 'right', 'left'];
    AnalyzeHelpers.table(
      ['Object', 'Category', 'Compressed', 'Decoded', 'Filter'],
      r.largestStreams.map((s) => [
        s.ref,
        AnalyzeHelpers.shortCat(s.category),
        AnalyzeHelpers.fmtBytes(s.raw),
        s.decoded != null ? AnalyzeHelpers.fmtBytes(s.decoded) : '—',
        s.filter,
      ]),
      streamAlign,
    );
    console.log('');

    // --- bottom line ---
    AnalyzeHelpers.line();
    console.log('Diagnosis');
    AnalyzeHelpers.line();
    for (const l of AnalyzeHelpers.diagnosis(r)) console.log(l);
    console.log('');

    void args; // args reserved for future flags (e.g. --verbose)
  }

  static printImageSummary(r: Report): void {
    const imgs = r.images ?? [];
    const eligible = imgs.filter((i) => i.eligible);
    console.log('Embedded raster images:');
    console.log('');
    if (imgs.length === 0) {
      console.log('  None found — there is essentially nothing for the image reducer to act on.');
      console.log('');
      return;
    }
    console.log(
      `  ${imgs.length} image(s); ${eligible.length} eligible for re-compression by reduce().`,
    );
    const skips: Record<string, number> = {};
    for (const i of imgs) {
      if (!i.eligible) {
        const reason = i.skipReason ?? 'unknown';
        skips[reason] = (skips[reason] ?? 0) + 1;
      }
    }
    for (const [reason, n] of Object.entries(skips)) {
      console.log(`    skipped: ${reason} × ${n}`);
    }
    console.log('');
  }

  /** One-sentence read on the content-stream operator mix. */
  static contentVerdict(r: Report): string {
    const g = r.operators.groups;
    const drawing = g.path + g.paint;
    if (g.textShow === 0 && drawing > 1000) {
      return 'No text-showing operators at all: the visible "text" is drawn as vector outlines (paths), not real text. There is no selectable/searchable text layer.';
    }
    if (drawing > g.textShow * 50 && drawing > 1000) {
      return 'Overwhelmingly vector-path drawing with very little real text — glyphs are likely converted to outlines and/or the page is heavy vector art.';
    }
    if (g.textShow > 0) {
      return 'Real text operators are present, so the document carries a genuine text layer.';
    }
    return 'Little drawing activity detected in content streams.';
  }

  /** The bottom-line explanation + recommendations, tailored to the numbers. */
  static diagnosis(r: Report): string[] {
    const out: string[] = [];
    const top = [...r.categories].sort((a, b) => b.raw - a.raw)[0];
    if (!top) return ['No stream payload found.'];

    const share = ((top.raw / r.fileBytes) * 100).toFixed(0);
    out.push(`  Dominant contributor: ${top.name}`);
    out.push(`  (${AnalyzeHelpers.fmtBytes(top.raw)}, ${share}% of the file across ${top.count} object(s)).`);
    out.push('');

    if (top.name === CATEGORY.CONTENT) {
      const g = r.operators.groups;
      const fonts = r.categories.find((c) => c.name === CATEGORY.FONT);
      const noText = g.textShow === 0;
      const decodedNote =
        top.decoded && top.decoded > top.raw
          ? ` They decompress to ~${AnalyzeHelpers.fmtBytes(top.decoded)} of drawing commands`
          : '';
      out.push(
        `  The weight is in page content streams, not images.${decodedNote}` +
          `${decodedNote ? '.' : ''}`,
      );
      if (noText) {
        out.push(
          `  There are no text-showing operators and ${fonts ? fonts.count + ' embedded font(s)' : 'no embedded fonts'}: ` +
            'every glyph you see is a filled vector path.',
        );
        out.push(
          '  This is typical of "print/convert to PDF" pipelines that outline fonts, or of',
        );
        out.push('  a scanned page traced into vectors.');
      }
      out.push('');
      out.push('  Why reduce() barely helped: it only re-compresses raster images, and this');
      out.push('  file is almost entirely vector drawing — there is nothing for it to touch.');
      out.push('');
      out.push('  To shrink this kind of PDF you would need a different tool, e.g.:');
      out.push('    • regenerate the PDF from the source with real, embedded fonts;');
      out.push('    • or rasterize each page to a JPEG and (optionally) re-OCR for text;');
      out.push('    • or run a vector/content-stream optimizer (out of scope for reduce()).');
    } else if (top.name === CATEGORY.IMAGE) {
      out.push('  The weight is in embedded raster images — this is exactly what reduce()');
      out.push('  targets. Check the eligibility summary above for any images it had to skip.');
    } else if (top.name === CATEGORY.FONT) {
      out.push('  The weight is in embedded font programs. Subsetting the fonts (removing');
      out.push('  unused glyphs) is the lever here — outside the scope of reduce().');
    } else {
      out.push(`  The weight is in "${top.name}". This is outside the scope of reduce(),`);
      out.push('  which only re-compresses embedded raster images.');
    }
    return out;
  }

  static fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  static shortCat(name: Category): string {
    const map: Record<Category, string> = {
      [CATEGORY.CONTENT]: 'content',
      [CATEGORY.IMAGE]: 'image',
      [CATEGORY.FORM]: 'form',
      [CATEGORY.FONT]: 'font',
      [CATEGORY.METADATA]: 'metadata',
      [CATEGORY.OBJSTM]: 'objstm',
      [CATEGORY.XREF]: 'xref',
      [CATEGORY.OTHER]: 'other',
    };
    return map[name] ?? name;
  }

  static table(headers: string[], rows: string[][], align: Align[]): void {
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
    );
    const fmtCell = (val: string, i: number): string => {
      const s = String(val);
      const pad = widths[i]! - s.length;
      return align[i] === 'right' ? ' '.repeat(pad) + s : s + ' '.repeat(pad);
    };
    const render = (cells: string[]): string =>
      '  ' + cells.map((c, i) => fmtCell(c, i)).join('  ');
    console.log(render(headers));
    console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of rows) console.log(render(r));
  }

  static line(): void {
    console.log('='.repeat(72));
  }

  static parseArgs(argv: string[]): Args {
    const args: Args = { input: null, json: false, top: 12, maxDecodeMb: 512 };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') args.json = true;
      else if (a === '--top') args.top = Math.max(1, parseInt(argv[++i] ?? '', 10) || args.top);
      else if (a === '--max-decode-mb')
        args.maxDecodeMb = Math.max(1, parseInt(argv[++i] ?? '', 10) || args.maxDecodeMb);
      else if (a !== undefined && !a.startsWith('-') && !args.input) args.input = a;
    }
    return args;
  }

  static safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }
}
