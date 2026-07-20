import type { ImageInspection } from '../pdfSizeReducer.js';

export const CATEGORY = {
  CONTENT: 'Content streams (page / vector graphics)',
  IMAGE: 'Image XObjects (raster)',
  FORM: 'Form XObjects',
  FONT: 'Embedded fonts',
  METADATA: 'Metadata (XMP)',
  OBJSTM: 'Object streams',
  XREF: 'Cross-reference streams',
  OTHER: 'Other streams',
} as const;
export type Category = (typeof CATEGORY)[keyof typeof CATEGORY];
export const CATEGORY_ORDER: Category[] = Object.values(CATEGORY);

export type Align = 'left' | 'right';

export interface Args {
  input: string | null;
  json: boolean;
  top: number;
  maxDecodeMb: number;
}

export interface CategoryBucket {
  name: Category;
  count: number;
  raw: number;
  decoded: number;
}

export interface StreamRecord {
  ref: string;
  category: Category;
  raw: number;
  decoded: number | null;
  filter: string;
}

export type OpGroupName = 'path' | 'paint' | 'textShow' | 'textObj' | 'xobject' | 'inlineImage';
export type OpGroups = Record<OpGroupName, number>;
export type OpCounts = Record<string, number>;

export interface OperatorSummary {
  groups: OpGroups;
  byOp: OpCounts;
}

export interface Report {
  file: string | null;
  fileBytes: number;
  pdfVersion: string;
  linearized: boolean;
  pageCount: number | null;
  objectCount: number;
  streamCount: number;
  nonStreamObjects: number;
  structuralOverhead: number;
  categories: CategoryBucket[];
  largestStreams: StreamRecord[];
  operators: OperatorSummary;
  scan: { decodedScanned: number; truncated: boolean; budgetMb: number };
  images?: ImageInspection[];
}
