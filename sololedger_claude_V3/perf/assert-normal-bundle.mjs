import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('dist');
const forbidden = ['__SOLOLEDGER_HOLDINGS_PERF__', 'sololedger:holdings-perf-result'];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  }));
  return nested.flat();
}

const files = await filesUnder(dist);
if (files.some((file) => path.basename(file) === 'holdings-perf.html')) {
  throw new Error('Normal production build unexpectedly contains holdings-perf.html');
}
for (const file of files.filter((candidate) => /\.(?:html|js|css)$/.test(candidate))) {
  const content = await readFile(file, 'utf8');
  for (const identifier of forbidden) {
    if (content.includes(identifier)) {
      throw new Error(`Normal production bundle ${path.relative(dist, file)} contains ${identifier}`);
    }
  }
}
console.log('Normal production bundle excludes holdings performance probe identifiers.');
