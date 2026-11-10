import { htmlDriver } from './html.js';
import type { Driver } from './types.js';

/**
 * Registry of code drivers. A config names its driver; adding a new one
 * (e.g. "json-api" for Algolia/RideMotive-style backends, or "browser" for
 * Playwright-only SPAs) is the only change that needs a deployment.
 */
const DRIVERS: Record<string, Driver> = {
  [htmlDriver.name]: htmlDriver,
};

export function getDriver(name: string): Driver {
  const driver = DRIVERS[name];
  if (!driver) throw new Error(`Unknown driver "${name}". Known: ${Object.keys(DRIVERS).join(', ')}`);
  return driver;
}

export function driverNames(): string[] {
  return Object.keys(DRIVERS);
}

export * from './types.js';
export { parseDetailPage, parseListPage } from './html.js';
