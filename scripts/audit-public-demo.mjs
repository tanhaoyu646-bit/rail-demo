import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist-public');
const reportPath = resolve(root, 'reports', 'public-demo-audit.json');
if (!dist.startsWith(`${root}${sep}`)) throw new Error(`Invalid public demo path: ${dist}`);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

const forbiddenNames = [
  'uploaded-hand-20260831.glb',
  'railway-uniform-dispatcher-lite.glb',
  'recorder-lite.glb',
  'driver-notebook-closed-lite.glb',
  'driver-notebook-open-lite.glb',
  'ic-card-lite.glb',
  'work-card-lite.glb',
];
const files = listFiles(dist);
const records = files.map(file => {
  const data = readFileSync(file);
  return {
    path: relative(dist, file).replaceAll('\\', '/'),
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
});
const forbidden = records.filter(record => forbiddenNames.some(name => record.path.endsWith(name)));
const sourceMaps = records.filter(record => extname(record.path) === '.map');
const bundledText = files.filter(file => /\.(?:js|css|html)$/i.test(file)).map(file => readFileSync(file, 'utf8')).join('\n');
const requiredWatermarkCount = bundledText.split('谭浩宇工作室').length - 1;
const privateAnswerFragments = [
  '加强瞭望、控制速度并提前采取制动措施',
  '保持常速，只增加鸣笛次数',
  '关闭LKJ提示避免干扰',
  '防滑、防空转并关注制动距离变化',
  '提高牵引力快速通过',
  '只核对车次和司机姓名',
  '只核对纸张页数',
  'uploaded-hand-20260831.glb',
  'railway-uniform-dispatcher-lite.glb',
  'recorder-lite.glb',
  'ic-card-lite.glb',
  'work-card-lite.glb',
  'driver-notebook-closed-lite.glb',
  'right-hand-fps-lite.glb',
];
const leakedAnswerFragments = privateAnswerFragments.filter(fragment => bundledText.includes(fragment));
const report = {
  createdAt: new Date().toISOString(),
  fileCount: records.length,
  totalBytes: records.reduce((sum, record) => sum + record.bytes, 0),
  forbidden,
  sourceMaps,
  requiredWatermarkCount,
  leakedAnswerFragments,
  files: records,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (forbidden.length || sourceMaps.length || requiredWatermarkCount < 1 || leakedAnswerFragments.length) {
  throw new Error(`Public demo audit failed; inspect ${reportPath}`);
}
console.log(JSON.stringify({ reportPath, fileCount: report.fileCount, totalBytes: report.totalBytes }));
