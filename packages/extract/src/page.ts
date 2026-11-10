import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { SpecBlock } from '@trnsact/core';

export interface Page {
  $: CheerioAPI;
  url: string;
}

export function loadPage(html: string, url: string): Page {
  return { $: cheerio.load(html), url };
}

/**
 * All schema.org JSON-LD nodes on the page whose @type matches. Handles
 * top-level arrays and @graph, and tolerates the malformed blocks that are
 * common in the wild (a broken block is skipped, not fatal).
 */
export function findJsonLd(page: Page, type: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  page.$('script[type="application/ld+json"]').each((_, el) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(page.$(el).text());
    } catch {
      return;
    }
    const queue: unknown[] = [parsed];
    while (queue.length) {
      const node = queue.shift();
      if (Array.isArray(node)) {
        queue.push(...node);
      } else if (node && typeof node === 'object') {
        const rec = node as Record<string, unknown>;
        if (Array.isArray(rec['@graph'])) queue.push(...rec['@graph']);
        const t = rec['@type'];
        if (t === type || (Array.isArray(t) && t.includes(type))) out.push(rec);
      }
    }
  });
  return out;
}

/** Label → value spec sheet. First occurrence of a label wins. */
export function parseSpecs(page: Page, blocks: readonly SpecBlock[]): Record<string, string> {
  const specs: Record<string, string> = {};
  const { $ } = page;
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

  for (const block of blocks) {
    $(block.row).each((_, row) => {
      const $row = $(row);
      const label = clean($row.find(block.label).first().text()).replace(/:$/, '');
      if (!label) return;
      let value: string;
      if (block.value) {
        value = clean($row.find(block.value).first().text());
      } else {
        const copy = $row.clone();
        copy.find(block.label).first().remove();
        value = clean(copy.text());
      }
      if (value && !(label in specs)) specs[label] = value;
    });
  }
  return specs;
}
