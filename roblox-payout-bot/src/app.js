import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
await import('../../bot.js');
