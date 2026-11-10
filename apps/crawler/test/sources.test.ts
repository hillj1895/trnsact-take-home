import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeUnit, parseDetailPage, parseListPage } from '@trnsact/extract';
import { FileConfigStore } from '../src/config-store.js';
import { SOURCES_DIR } from '../src/paths.js';

/**
 * Contract test run for EVERY source config that ships fixtures. Onboarding a
 * dealer = config + `fixtures:capture` + expectations in manifest.json; this
 * test then guards it offline in CI. When a site's layout changes, re-capture,
 * watch this go red, fix the config (data), bump its version.
 */
interface Manifest {
  list: Array<{ file: string; url: string }>;
  detail: Array<{ file: string; url: string }>;
  expect: {
    minListItems: number;
    listFields: string[];
    unitFields: string[];
    minImages?: number;
    minSpecs?: number;
  };
}

const store = new FileConfigStore(SOURCES_DIR);
const loaded = await store.list();
const SCRAPED_AT = '2026-01-01T00:00:00.000Z';

describe('source configs', () => {
  it.each(loaded.map((c) => [path.basename(c.origin), c] as const))('%s validates', (_, c) => {
    expect(c.errors).toEqual([]);
  });
});

for (const { config } of loaded) {
  if (!config) continue;
  const dir = path.join(SOURCES_DIR, 'fixtures', config.id);
  if (!existsSync(path.join(dir, 'manifest.json'))) continue;

  describe(`fixtures: ${config.id}`, async () => {
    const manifest: Manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const read = (f: string) => readFile(path.join(dir, f), 'utf8');

    for (const page of manifest.list) {
      it(`parses list page ${page.file}`, async () => {
        const result = parseListPage(config, await read(page.file), page.url);
        expect(result.stubs.length).toBeGreaterThanOrEqual(manifest.expect.minListItems);
        expect(new Set(result.stubs.map((s) => s.key)).size).toBe(result.stubs.length);
        for (const stub of result.stubs) {
          for (const f of manifest.expect.listFields) {
            expect(stub.fields, `${stub.key} missing list field ${f}`).toHaveProperty(f);
          }
        }
      });
    }

    for (const page of manifest.detail) {
      it(`parses + normalizes detail page ${page.file}`, async () => {
        // Pair the detail page with its list card when the list fixture has it.
        const listHtml = manifest.list[0] ? await read(manifest.list[0].file) : undefined;
        const stubs = listHtml ? parseListPage(config, listHtml, manifest.list[0]!.url).stubs : [];
        const stub = stubs.find((s) => s.url === page.url) ?? {
          key: 'fixture',
          url: page.url,
          fields: {},
          warnings: [],
          foundOn: page.url,
        };
        const detail = parseDetailPage(config, await read(page.file), page.url);
        const result = normalizeUnit(config, stub, detail, SCRAPED_AT);
        if (!result.ok) throw new Error(result.errors.join('\n'));

        const unit = result.unit as unknown as Record<string, unknown>;
        for (const f of manifest.expect.unitFields) {
          expect(unit[f], `unit missing ${f}`).not.toBeUndefined();
        }
        expect(result.unit.media.filter((m) => m.kind === 'image').length).toBeGreaterThanOrEqual(
          manifest.expect.minImages ?? 0,
        );
        expect(Object.keys(result.unit.specs).length).toBeGreaterThanOrEqual(manifest.expect.minSpecs ?? 0);
        // Golden snapshot: any config or parser change that alters output shows up in review.
        expect(result.unit).toMatchSnapshot();
      });
    }
  });
}
