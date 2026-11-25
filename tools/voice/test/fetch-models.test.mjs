// SubStage_1.1 §6 的五条单测：校验失败路径、--record 写回格式、解包拍平、清单自洽。
// 全部离线：不下载、不读真实 models/，每个用例各自建临时 voice 根目录。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  MANIFEST_PATH,
  checkAssets,
  flattenSingleRootDir,
  readManifestFile,
  recordAssets,
  serializeManifest,
} from '../fetch-models.mjs';

const PAYLOAD = 'hello world!';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeVoiceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-fetch-'));
  fs.mkdirSync(path.join(root, 'models'), { recursive: true });
  return root;
}

function writeManifest(file, doc) {
  fs.writeFileSync(file, serializeManifest(doc), 'utf8');
  return file;
}

function singleAssetDoc({ size = Buffer.byteLength(PAYLOAD), sha256: digest = '' } = {}) {
  return {
    v: 1,
    python: '3.12',
    pipIndex: 'https://example.invalid/simple',
    assets: [
      {
        id: 'vad',
        url: 'https://example.invalid/vad/silero_vad.onnx',
        mirror: null,
        dest: 'models/vad/silero_vad.onnx',
        extract: 'none',
        size,
        sha256: digest,
      },
    ],
  };
}

function indentProfile(text) {
  return text.split('\n').map((line) => (line.match(/^ */) || [''])[0].length);
}

test('1. --check 对缺失文件返回 2 且输出含 missing', async (t) => {
  const root = makeVoiceRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = writeManifest(path.join(root, 'manifest.json'), singleAssetDoc({ sha256: sha256(PAYLOAD) }));

  const lines = [];
  const { code, results } = await checkAssets({
    voiceRoot: root,
    doc: readManifestFile(manifest),
    log: (line) => lines.push(line),
  });

  assert.equal(code, 2);
  assert.equal(results[0].reason, 'missing');
  assert.match(lines.join('\n'), /missing/);
});

test('2. --check 对篡改过 1 字节的文件返回 2 且输出含 sha256', async (t) => {
  const root = makeVoiceRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = writeManifest(path.join(root, 'manifest.json'), singleAssetDoc({ sha256: sha256(PAYLOAD) }));

  const target = path.join(root, 'models', 'vad', 'silero_vad.onnx');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'hellp world!'); // 同长度，只改 1 字节

  const lines = [];
  const { code, results } = await checkAssets({
    voiceRoot: root,
    doc: readManifestFile(manifest),
    log: (line) => lines.push(line),
  });

  assert.equal(code, 2);
  assert.equal(results[0].reason, 'sha256');
  assert.match(lines.join('\n'), /sha256/);
});

test('3. --record 写回后仍是 2 空格缩进、字段顺序不变', async (t) => {
  const root = makeVoiceRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = writeManifest(path.join(root, 'manifest.json'), singleAssetDoc());

  const target = path.join(root, 'models', 'vad', 'silero_vad.onnx');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, PAYLOAD);

  const before = fs.readFileSync(manifest, 'utf8');
  const failed = await recordAssets({ voiceRoot: root, manifestPath: manifest, log: () => {} });
  const after = fs.readFileSync(manifest, 'utf8');

  assert.equal(failed, 0);
  const parsed = JSON.parse(after);
  const original = JSON.parse(before);
  assert.equal(parsed.assets[0].bytes, undefined);
  assert.equal(parsed.assets[0].size, Buffer.byteLength(PAYLOAD));
  assert.equal(parsed.assets[0].sha256, sha256(PAYLOAD));
  assert.deepEqual(Object.keys(parsed), Object.keys(original));
  assert.deepEqual(Object.keys(parsed.assets[0]), Object.keys(original.assets[0]));
  assert.deepEqual(indentProfile(after), indentProfile(before));
  assert.equal(serializeManifest(parsed), after);
});

test('4. tar.bz2 解包拍平：xxx/tokens.txt 落到 models/kws/tokens.txt', async (t) => {
  const root = makeVoiceRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const scratch = path.join(root, 'models', '.cache', 'kws.extract-0');
  const inner = path.join(scratch, 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'tokens.txt'), 'x 1\n');

  flattenSingleRootDir(scratch, path.join(root, 'models', 'kws'));

  const flattened = path.join(root, 'models', 'kws', 'tokens.txt');
  assert.ok(fs.existsSync(flattened), `没有拍平到 ${flattened}`);
  assert.equal(fs.readFileSync(flattened, 'utf8'), 'x 1\n');
  assert.equal(fs.existsSync(path.join(inner, 'tokens.txt')), false);
});

test('5. 真实清单：7 个基础资产 + SubStage 5.2 的 base-hf，id 与 dest 都不重复', async () => {
  const doc = readManifestFile(MANIFEST_PATH);

  assert.equal(doc.v, 1);
  assert.equal(doc.python, '3.12');
  assert.match(doc.pipIndex, /^https:\/\//);

  // SubStage 1.1/5.1 的 7 个资产保持原样；base-hf-* 是 SubStage 5.2 §2 追加的 HF 基座权重。
  const legacy = doc.assets.filter((asset) => !asset.id.startsWith('base-hf-'));
  const baseHf = doc.assets.filter((asset) => asset.id.startsWith('base-hf-'));
  assert.equal(legacy.length, 7);
  assert.ok(baseHf.length >= 5, `base-hf 条目太少：${baseHf.length}`);
  for (const asset of baseHf) {
    assert.ok(asset.dest.startsWith('models/base-hf/Qwen3-1.7B/'), `${asset.id} 的 dest 不在 models/base-hf 下`);
  }

  const ids = doc.assets.map((asset) => asset.id);
  const dests = doc.assets.map((asset) => asset.dest.toLowerCase());
  assert.equal(new Set(ids).size, ids.length, `资产 id 重复：${ids.join(', ')}`);
  assert.equal(new Set(dests).size, dests.length, `资产 dest 重复：${dests.join(', ')}`);

  for (const asset of doc.assets) {
    for (const field of ['id', 'url', 'mirror', 'dest', 'extract', 'size', 'sha256']) {
      assert.ok(Object.hasOwn(asset, field), `${asset.id} 缺字段 ${field}`);
    }
    assert.ok(['zip', 'tar.bz2', 'none'].includes(asset.extract), `${asset.id} 的 extract 非法`);
    assert.ok(asset.dest.startsWith('models/'), `${asset.id} 的 dest 必须在 models/ 下`);
  }
});
