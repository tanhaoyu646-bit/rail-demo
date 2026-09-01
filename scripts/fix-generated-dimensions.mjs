import { readFile, writeFile } from 'node:fs/promises';

const [specPath, factoryPath, passId = 'structural-pass'] = process.argv.slice(2);
if (!specPath || !factoryPath) {
  throw new Error('Usage: node scripts/fix-generated-dimensions.mjs <spec.json> <factory.ts> [pass-id]');
}

const spec = JSON.parse(await readFile(specPath, 'utf8'));
let source = await readFile(factoryPath, 'utf8');
const allowedLevels = new Set(
  passId === 'blockout' ? ['macro'] : passId === 'structural-pass' ? ['macro', 'meso'] : ['macro', 'meso', 'micro'],
);
const componentList = Array.isArray(spec.components) ? spec.components : spec.componentTree;
if (!Array.isArray(componentList)) throw new Error('Spec has no component array.');
const components = componentList.filter((component) => allowedLevels.has(component.level));

for (const [index, component] of components.entries()) {
  const slug = component.id.replace(/[^a-zA-Z0-9_]/g, '_');
  const marker = `const endpoint_${slug}_${index}`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) continue;
  const scalePattern = new RegExp(`mesh_${slug}_${index}Geometry\\.scale\\(1\\.0, 1\\.0, 1\\.0\\);`);
  const tail = source.slice(markerIndex);
  const match = tail.match(scalePattern);
  if (!match || match.index === undefined) continue;
  const dimensions = component.dimensions ?? {};
  const replacement = `mesh_${slug}_${index}Geometry.scale(${dimensions.width ?? 1}, ${dimensions.height ?? 1}, ${dimensions.depth ?? 1});`;
  const absoluteIndex = markerIndex + match.index;
  source = source.slice(0, absoluteIndex) + replacement + source.slice(absoluteIndex + match[0].length);
}

await writeFile(factoryPath, source, 'utf8');
console.log(`Applied component dimensions for ${components.length} ${passId} components.`);
