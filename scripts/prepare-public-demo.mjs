import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const source = resolve(root, 'public');
const target = resolve(root, 'working', 'public-demo');
const dist = resolve(root, 'dist-public');

if (target !== resolve(root, 'working', 'public-demo') || !target.startsWith(`${root}${sep}`)
  || dist !== resolve(root, 'dist-public') || !dist.startsWith(`${root}${sep}`)) {
  throw new Error(`Refusing to prepare assets outside project: ${target}`);
}

function clearDirectory(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (!absolute.startsWith(`${directory}${sep}`)) throw new Error(`Unsafe cleanup target: ${absolute}`);
    if (entry.isDirectory()) {
      clearDirectory(absolute);
    } else unlinkSync(absolute);
  }
  rmdirSync(directory);
}
clearDirectory(target);
clearDirectory(dist);
mkdirSync(target, { recursive: true });

const explicitFiles = [
  'assets/props/recorder.png',
  'assets/props/ic-card.png',
];

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

const documentRoot = resolve(source, 'assets', 'documents');
const files = [
  ...explicitFiles.map(path => resolve(source, path)),
  ...listFiles(documentRoot),
];

let totalBytes = 0;
for (const file of files) {
  if (!file.startsWith(`${source}${sep}`) || !statSync(file).isFile()) {
    throw new Error(`Invalid public-demo source: ${file}`);
  }
  const destination = resolve(target, relative(source, file));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file, destination);
  totalBytes += statSync(file).size;
}

writeFileSync(resolve(target, '.nojekyll'), '');
writeFileSync(resolve(target, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

console.log(JSON.stringify({ target, fileCount: files.length, totalBytes }));
