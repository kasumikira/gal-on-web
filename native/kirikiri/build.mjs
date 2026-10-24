import { spawnSync } from 'node:child_process';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { availableParallelism } from 'node:os';

const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'out/kirikiri');
for (const name of ['EMSDK', 'VCPKG_ROOT']) {
  if (!process.env[name]) throw new Error(`Missing ${name}; see native/kirikiri/README.md`);
}
const expectedMajor = readFileSync(path.join(root, 'native/emscripten-major.txt'), 'utf8').trim();
const version = readFileSync(path.join(process.env.EMSDK, 'upstream/emscripten/emscripten-version.txt'), 'utf8').trim().replaceAll('"', '');
if (version.split('.')[0] !== expectedMajor) {
  throw new Error(`Expected Emscripten ${expectedMajor}.x, found ${version}; activate a supported SDK first`);
}
console.log(`Building Kirikiri with Emscripten ${version}`);
const jobs = String(availableParallelism());
const env = {
  ...process.env,
  CMAKE_BUILD_PARALLEL_LEVEL: process.env.CMAKE_BUILD_PARALLEL_LEVEL ?? jobs,
  VCPKG_MAX_CONCURRENCY: process.env.VCPKG_MAX_CONCURRENCY ?? jobs,
};
function run(args) {
  const result = spawnSync('cmake', args, { cwd: import.meta.dirname, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CMake failed (${result.status})`);
}
run(['--preset', 'wasm-release']);
run(['--build', '--preset', 'wasm-release']);
const destination = path.join(root, 'web/engine-js/tjs-runtime');
mkdirSync(destination, { recursive: true });
for (const extension of ['js', 'wasm']) {
  const name = 'tjs-runtime.' + extension;
  copyFileSync(path.join(output, name), path.join(destination, name));
}
