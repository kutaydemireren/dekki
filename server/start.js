// `npm start`: build the frontend if dist/ is missing, then serve.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from './index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html')) && fs.existsSync(path.join(ROOT, 'web', 'index.html'))) {
  console.log('Building frontend…');
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' });
}
await main();
