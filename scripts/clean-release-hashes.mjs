import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const projectRoot = resolve(process.cwd());
const assetDirectory = resolve(projectRoot, 'release-current', 'assets');
if (!assetDirectory.startsWith(`${projectRoot}${sep}`)) {
  throw new Error(`Refusing to clean outside project: ${assetDirectory}`);
}

try {
  for (const name of readdirSync(assetDirectory)) {
    if (!/^index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(name)) continue;
    const target = resolve(assetDirectory, name);
    if (!target.startsWith(`${assetDirectory}${sep}`) || !statSync(target).isFile()) continue;
    unlinkSync(target);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
