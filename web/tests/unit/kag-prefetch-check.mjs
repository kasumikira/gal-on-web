// KAG lookahead prefetch: getNextTag drives speculative storage hints (op 20)
// without touching parse semantics.
import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';
import { config } from '../../engine-js/global.js';

const SCENARIO = [
  '*start',
  '[bg storage="bg/room1.tlg"]',
  '[chara storage="fg/heroine.png" layer=0]',
  '[playbgm storage="bgm/title01.ogg"]',
  'Some plain text.',
  '[wait time=500]',
  '[s]',
  '',
].join('\r\n');

const scenarioBytes = Uint8Array.from(Buffer.from(SCENARIO, 'utf8'));
const hints = [];
const storage = {
  normalize: name => String(name).replace(/^\//, '').toLowerCase(),
  async exists(name) { return storage.normalize(name) === 'test.ks'; },
  async read(name) { return scenarioBytes.slice(); },
  async readPlaced(name) { return storage.read(name); },
  async getPlacedPath(name) { return await storage.exists(name) ? name : ''; },
  clearArchiveCache() {},
  addAutoPath() {},
  removeAutoPath() {},
  prefetch(name) { hints.push(String(name)); },
};

const vm = await new TJSInterop().init(Object.create(null));
Object.assign(config, {
  document: { defaultView: {} }, inform: () => {}, arguments: {},
  continuousFrameRate: 60, onTitleChange: () => {},
});
vm.attachStorage({ ...storage, currentDirectory: '/' });

const parsed = await vm.source(`
  var p = new KAGParser();
  p.loadScenario("test.ks");
  var names = "";
  for (var guard = 0; guard < 100; guard++) {
    var t = p.getNextTag();
    if (typeof t == "void") break;
    try { names += t.storage + "\\n"; } catch (e) { }
  }
  return names;
`, 'kag-prefetch');
const storages = parsed.split('\n').filter(Boolean);

assert.deepEqual(storages, ['bg/room1.tlg', 'fg/heroine.png', 'bgm/title01.ogg'],
  'tags still parse with storage attributes in order');

const expected = new Set(['bg/room1.tlg', 'fg/heroine.png', 'bgm/title01.ogg']);
const received = new Set(hints);
for (const name of expected)
  assert.ok(received.has(name), `prefetch hint missing: ${name} (got ${JSON.stringify(hints)})`);
for (const name of hints)
  assert.ok(name.includes('.'), `hint without extension leaked: ${name}`);
assert.ok(!hints.includes('500'), 'unquoted attribute value must not become a hint');

console.log('kag-prefetch-check passed');
