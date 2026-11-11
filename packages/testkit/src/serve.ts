import { MockDealer } from './mock-dealer.js';

/**
 * Run the mock dealer standalone for manual poking:
 *   pnpm mock:serve [port]
 *   pnpm crawl transwest --base-url http://127.0.0.1:4010 --no-persist
 */
const port = Number(process.argv[2] ?? 4010);
const site = await new MockDealer().start(port);
console.log(`mock dealer (${site.inventory.length} units) at ${site.url}`);
console.log(`  ${site.url}/trucks/type/all/store/   ${site.url}/trailers/type/all/store/`);
