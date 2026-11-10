import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SOURCES_DIR = process.env.SOURCES_DIR ?? path.join(REPO_ROOT, 'sources');
export const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(REPO_ROOT, '.output');
