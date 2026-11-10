import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Extractor, FieldRule } from '@trnsact/core';
import type { Page } from './page.js';
import { getPath } from './json-path.js';
import { applyTransforms, isEmpty, type Scalar } from './transforms.js';

/** Everything an extractor may read from. */
export interface Scope {
  page: Page;
  /** Element to resolve DOM selectors against (a list card). Omit for the whole page. */
  el?: Cheerio<AnyNode>;
  jsonLd?: Record<string, unknown>;
  specs?: Record<string, string>;
}

/** Evaluate one extractor and return every non-empty value it produces. */
export function extractValues(ex: Extractor, scope: Scope): Scalar[] {
  if (ex.from === 'const') return [ex.value];

  let raw: unknown[];
  if (ex.from === 'jsonld') {
    raw = scope.jsonLd ? getPath(scope.jsonLd, ex.path) : [];
  } else if (ex.from === 'spec') {
    const labels = (Array.isArray(ex.label) ? ex.label : [ex.label]).map((l) => l.toLowerCase());
    const entries = Object.entries(scope.specs ?? {});
    const hit = labels.map((l) => entries.find(([k]) => k.toLowerCase() === l)).find(Boolean);
    raw = hit ? [hit[1]] : [];
  } else {
    raw = readDom(ex, scope);
  }

  const out: Scalar[] = [];
  for (const r of raw) {
    let v: Scalar = toScalar(r);
    if (v !== null && ex.regex) {
      const m = new RegExp(ex.regex, 'i').exec(String(v));
      v = m ? (m[1] ?? m[0]) : null;
    }
    v = applyTransforms(v, ex.transforms, { pageUrl: scope.page.url });
    if (v !== null && ex.map) {
      const key = String(v).trim().toLowerCase();
      const mapped = Object.entries(ex.map).find(([k]) => k.toLowerCase() === key);
      if (mapped) v = mapped[1];
    }
    if (!isEmpty(v)) out.push(v);
  }
  return out;
}

type DomExtractor = Exclude<Extractor, { from: 'jsonld' | 'spec' | 'const' }>;

function readDom(ex: DomExtractor, scope: Scope): unknown[] {
  const { $ } = scope.page;
  const nodes = ex.selector
    ? scope.el
      ? scope.el.find(ex.selector)
      : $(ex.selector)
    : (scope.el ?? $.root().children());

  const values: unknown[] = [];
  nodes.each((_, node) => {
    const $n = $(node);
    const text = ex.attr ? $n.attr(ex.attr) : $n.text();
    if (text === undefined) return;
    if (!ex.json) {
      values.push(text);
      return;
    }
    try {
      values.push(...getPath(JSON.parse(text), ex.json));
    } catch {
      // Malformed JSON in an attribute: treat as missing, not fatal.
    }
  });
  return values;
}

function toScalar(v: unknown): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

export interface RuleResult {
  value: Scalar | undefined;
  /** Values from lower-priority extractors that disagreed with the chosen one. */
  conflicts: Scalar[];
}

/**
 * Evaluate a field rule: a single extractor or an ordered fallback chain.
 * The first extractor that yields a value wins. Lower-priority extractors are
 * still evaluated so disagreements between a page's data sources (e.g. JSON-LD
 * vs. the visible spec table) are surfaced instead of silently ignored.
 */
export function evaluateRule(rule: FieldRule, scope: Scope): RuleResult {
  const chain = Array.isArray(rule) ? rule : [rule];
  let value: Scalar | undefined;
  const conflicts: Scalar[] = [];
  for (const ex of chain) {
    const v = extractValues(ex, scope)[0];
    if (v === undefined) continue;
    if (value === undefined) value = v;
    else if (!sameValue(value, v)) conflicts.push(v);
  }
  return { value, conflicts };
}

export function sameValue(a: Scalar, b: Scalar): boolean {
  const norm = (x: Scalar) => String(x).replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}
