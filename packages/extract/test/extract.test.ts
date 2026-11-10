import { describe, expect, it } from 'vitest';
import { evaluateRule, extractValues, getPath, loadPage, parseSpecs, findJsonLd } from '../src/index.js';

const html = `
<html><head>
  <script type="application/ld+json">{ not valid json </script>
  <script type="application/ld+json">{"@graph":[{"@type":"Vehicle","sku":"A1","image":[{"url":"/i/1.jpg"},{"url":"/i/2.jpg"}],"itemCondition":"NewCondition"}]}</script>
</head><body>
  <li class="card" wire:key="product-42-0" data-price="$79,900" data-attrs='{"vin":"1ftfw1e50nfa00001","status":"Available"}'>
    <a href="/units/a1">2019 Freightliner</a>
  </li>
  <ul class="specs"><li><span>Condition</span> Used </li><li><span>Mileage</span> 162,371 mi</li></ul>
  <dl><div class="row"><dt>Engine Make</dt><dd> Cummins </dd></div></dl>
</body></html>`;

const page = loadPage(html, 'https://dealer.example/inventory/?page=1');
const card = page.$('li.card');

describe('json-path', () => {
  it('resolves nested and flattened paths', () => {
    const obj = { a: { b: [{ c: 1 }, { c: 2 }] } };
    expect(getPath(obj, 'a.b[].c')).toEqual([1, 2]);
    expect(getPath(obj, 'a.b[1].c')).toEqual([2]);
    expect(getPath(obj, 'a.missing')).toEqual([]);
  });
});

describe('dom extractors', () => {
  it('reads attributes on the scope element with regex', () => {
    expect(extractValues({ attr: 'wire:key', regex: 'product-(\\d+)', transforms: [] }, { page, el: card })).toEqual(['42']);
  });
  it('parses JSON attributes and applies transforms', () => {
    expect(extractValues({ attr: 'data-attrs', json: 'vin', transforms: ['upper'] }, { page, el: card })).toEqual([
      '1FTFW1E50NFA00001',
    ]);
    expect(extractValues({ attr: 'data-price', transforms: ['price'] }, { page, el: card })).toEqual([79900]);
  });
  it('resolves relative URLs against the page', () => {
    expect(extractValues({ selector: 'a', attr: 'href', transforms: ['absUrl'] }, { page, el: card })).toEqual([
      'https://dealer.example/units/a1',
    ]);
  });
});

describe('JSON-LD + specs', () => {
  const jsonLd = findJsonLd(page, 'Vehicle')[0];
  const specs = parseSpecs(page, [
    { row: 'ul.specs li', label: 'span' },
    { row: 'dl .row', label: 'dt', value: 'dd' },
  ]);

  it('skips malformed blocks and finds nodes inside @graph', () => {
    expect(jsonLd?.sku).toBe('A1');
  });

  it('parses both spec layouts', () => {
    expect(specs).toEqual({ Condition: 'Used', Mileage: '162,371 mi', 'Engine Make': 'Cummins' });
  });

  it('records disagreement between sources in a fallback chain', () => {
    const r = evaluateRule(
      [
        { from: 'spec', label: 'Condition', transforms: [] },
        { from: 'jsonld', path: 'itemCondition', regex: '^(New|Used)', transforms: [] },
      ],
      { page, jsonLd, specs },
    );
    expect(r.value).toBe('Used');
    expect(r.conflicts).toEqual(['New']);
  });
});
