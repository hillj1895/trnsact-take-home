import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SourceConfig } from '@trnsact/core';
import { driverNames } from '@trnsact/extract';

export interface LoadedConfig {
  origin: string;
  config?: SourceConfig;
  errors: string[];
}

/**
 * Where source configs live. The crawler reads configs at runtime, so adding or
 * fixing a dealer is a data change, not a deploy. Today: JSON files in /sources.
 * In AWS: an S3 prefix or a `sources` table (with version history + an admin UI),
 * behind this same interface.
 */
export interface ConfigStore {
  list(): Promise<LoadedConfig[]>;
  get(id: string): Promise<SourceConfig>;
}

export class FileConfigStore implements ConfigStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<LoadedConfig[]> {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')).sort();
    return Promise.all(files.map((f) => this.load(path.join(this.dir, f))));
  }

  async get(id: string): Promise<SourceConfig> {
    const all = await this.list();
    const hit = all.find((c) => c.config?.id === id || path.basename(c.origin, '.json') === id);
    if (!hit) throw new Error(`No source config "${id}" in ${this.dir}`);
    if (!hit.config) throw new Error(`Source config ${hit.origin} is invalid:\n  ${hit.errors.join('\n  ')}`);
    return hit.config;
  }

  private async load(file: string): Promise<LoadedConfig> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      return { origin: file, errors: [`invalid JSON: ${(err as Error).message}`] };
    }
    return validateConfig(raw, file);
  }
}

/** Schema validation + semantic checks a JSON schema can't express. */
export function validateConfig(raw: unknown, origin: string): LoadedConfig {
  const parsed = SourceConfig.safeParse(raw);
  if (!parsed.success) {
    return { origin, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const config = parsed.data;
  const errors: string[] = [];

  if (!driverNames().includes(config.driver)) {
    errors.push(`driver: unknown "${config.driver}" (known: ${driverNames().join(', ')})`);
  }
  if (!config.list.fields.listingUrl) errors.push('list.fields.listingUrl: required to follow units');
  const listFields = new Set(Object.keys(config.list.fields));
  if (!config.identity.some((f) => listFields.has(f))) {
    errors.push('identity: at least one identity field must be extracted on the list page');
  }
  for (const [where, re] of collectRegexes(config)) {
    try {
      new RegExp(re);
    } catch (err) {
      errors.push(`${where}: invalid regex ${re} (${(err as Error).message})`);
    }
  }
  return errors.length ? { origin, errors } : { origin, config, errors };
}

function collectRegexes(config: SourceConfig): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${at}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'regex' || k === 'include' || k === 'exclude') && typeof v === 'string') out.push([`${at}.${k}`, v]);
        else walk(v, `${at}.${k}`);
      }
    }
  };
  walk(config, '');
  return out;
}
