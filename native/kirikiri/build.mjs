import { spawnSync } from 'node:child_process';
import { readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'out/kirikiri');
const cache = readFileSync(path.join(output, 'CMakeCache.txt'), 'utf8');
function setting(name) {
  const match = cache.match(new RegExp('^' + name + ':[^=]*=(.*)$', 'm'));
  if (!match) throw Error('Missing configured build setting: ' + name);
  return match[1].trim();
}
const sdk=path.join(root,'tools/emsdk');
const env={...process.env,EMSDK:sdk,EMSCRIPTEN_ROOT:path.join(sdk,'upstream/emscripten'),EM_CONFIG:path.join(sdk,'.emscripten'),PATH:[path.join(sdk,'upstream/emscripten'),process.env.PATH].join(path.delimiter)};
function run(args) {
  const result = spawnSync('cmake', args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status) throw Error('Build failed: ' + result.status);
}
run(['-S',import.meta.dirname,'-B',output,'-G','Ninja',
  '-DCMAKE_BUILD_TYPE=Release','-DVCPKG_TARGET_TRIPLET=wasm32-emscripten','-DVCPKG_MANIFEST_INSTALL=OFF',
  '-DVCPKG_MANIFEST_DIR='+path.join(root,'native/kirikiri'),
  '-DVCPKG_INSTALLED_DIR=' + setting('VCPKG_INSTALLED_DIR'),
  ...['CMAKE_TOOLCHAIN_FILE','VCPKG_CHAINLOAD_TOOLCHAIN_FILE','CMAKE_MAKE_PROGRAM','BISON_EXECUTABLE'].map(name=>'-D'+name+'='+setting(name))]);
run(['--build',output,'--target','tjs-runtime','-j','4']);
for (const extension of ['js', 'wasm']) {
  const name = 'tjs-runtime.' + extension;
  copyFileSync(path.join(output, name), path.join(root, 'web/engine-js/tjs-runtime', name));
}
