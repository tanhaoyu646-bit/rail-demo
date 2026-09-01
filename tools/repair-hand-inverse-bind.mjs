import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  throw new Error('Usage: node repair-hand-inverse-bind.mjs <input.glb> <output.glb>');
}

const source = fs.readFileSync(inputPath);
if (source.toString('ascii', 0, 4) !== 'glTF') throw new Error('Input is not a GLB file.');

const jsonLength = source.readUInt32LE(12);
const jsonStart = 20;
const json = JSON.parse(source.toString('utf8', jsonStart, jsonStart + jsonLength).replace(/\0+$/, ''));
const binaryHeader = jsonStart + jsonLength;
const binaryStart = binaryHeader + 8;
const patchedBinary = Buffer.from(source);

let repairedMatrices = 0;
const bindWorldMatrices = new Map();
for (const skin of json.skins ?? []) {
  if (skin.inverseBindMatrices === undefined) continue;
  const accessor = json.accessors?.[skin.inverseBindMatrices];
  if (!accessor || accessor.type !== 'MAT4' || accessor.componentType !== 5126) {
    throw new Error('Expected inverse bind matrices to use MAT4/FLOAT accessors.');
  }
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error('Missing inverse bind matrix buffer view.');
  const stride = view.byteStride ?? 64;
  const accessorStart = binaryStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  for (let matrixIndex = 0; matrixIndex < accessor.count; matrixIndex += 1) {
    const offset = accessorStart + matrixIndex * stride;
    const values = Array.from({ length: 16 }, (_, index) => source.readFloatLE(offset + index * 4));
    const transposed = Array(16).fill(0);
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        transposed[row * 4 + column] = values[column * 4 + row];
        patchedBinary.writeFloatLE(transposed[row * 4 + column], offset + (row * 4 + column) * 4);
      }
    }
    const jointNode = skin.joints[matrixIndex];
    bindWorldMatrices.set(jointNode, new THREE.Matrix4().fromArray(transposed).invert());
    repairedMatrices += 1;
  }
  skin.skeleton = skin.joints[0];
}

const parentByNode = new Map();
for (let nodeIndex = 0; nodeIndex < (json.nodes?.length ?? 0); nodeIndex += 1) {
  for (const child of json.nodes[nodeIndex].children ?? []) parentByNode.set(child, nodeIndex);
}

const translation = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const scale = new THREE.Vector3();
for (const [nodeIndex, worldMatrix] of bindWorldMatrices) {
  const parentIndex = parentByNode.get(nodeIndex);
  const parentWorld = parentIndex === undefined ? null : bindWorldMatrices.get(parentIndex);
  const localMatrix = parentWorld
    ? parentWorld.clone().invert().multiply(worldMatrix)
    : worldMatrix.clone();
  localMatrix.decompose(translation, rotation, scale);
  const node = json.nodes[nodeIndex];
  node.translation = translation.toArray();
  node.rotation = rotation.toArray();
  node.scale = scale.toArray();
  delete node.matrix;
}

// Make the skeleton root and skinned mesh scene roots. A skinned mesh below a
// glTF node cannot reliably inherit that node's transform in runtime engines.
for (const scene of json.scenes ?? []) {
  const requiredNodes = new Set();
  for (const skin of json.skins ?? []) requiredNodes.add(skin.joints[0]);
  for (let nodeIndex = 0; nodeIndex < (json.nodes?.length ?? 0); nodeIndex += 1) {
    if (json.nodes[nodeIndex].skin !== undefined) requiredNodes.add(nodeIndex);
  }
  for (const node of json.nodes ?? []) {
    if (!node.children) continue;
    node.children = node.children.filter((child) => !requiredNodes.has(child));
    if (!node.children.length) delete node.children;
  }
  scene.nodes = [...requiredNodes];
}
json.asset.generator = `${json.asset.generator ?? 'unknown'}; repaired inverse-bind layout and joint hierarchy`;

const binaryLength = source.readUInt32LE(binaryHeader);
const binaryType = source.readUInt32LE(binaryHeader + 4);
const binaryData = patchedBinary.subarray(binaryStart, binaryStart + binaryLength);
const jsonData = Buffer.from(JSON.stringify(json), 'utf8');
const paddedJsonLength = Math.ceil(jsonData.length / 4) * 4;
const totalLength = 12 + 8 + paddedJsonLength + 8 + binaryLength;
const output = Buffer.alloc(totalLength, 0x20);
output.write('glTF', 0, 4, 'ascii');
output.writeUInt32LE(2, 4);
output.writeUInt32LE(totalLength, 8);
output.writeUInt32LE(paddedJsonLength, 12);
output.writeUInt32LE(0x4e4f534a, 16);
jsonData.copy(output, 20);
const outputBinaryHeader = 20 + paddedJsonLength;
output.writeUInt32LE(binaryLength, outputBinaryHeader);
output.writeUInt32LE(binaryType, outputBinaryHeader + 4);
binaryData.copy(output, outputBinaryHeader + 8);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);
console.log(JSON.stringify({ inputPath, outputPath, repairedMatrices, repairedJoints: bindWorldMatrices.size }));
