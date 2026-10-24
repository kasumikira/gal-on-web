import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const target = path.join(root, 'out/codecs-rust');
const env = { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C target-feature=+simd128`.trim() };
const result = spawnSync('cargo', [
  'build', '--manifest-path', path.join(import.meta.dirname, 'Cargo.toml'),
  '--release', '--target', 'wasm32-unknown-unknown', '--target-dir', target,
], { cwd: root, env, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Rust codec build failed (${result.status})`);

const wasm = path.join(target, 'wasm32-unknown-unknown/release/gal_codecs.wasm');
const output = path.join(root, 'web/engine-js/codecs/codecs.wasm');
mkdirSync(path.dirname(output), { recursive: true });
copyFileSync(wasm, output);
console.log(`Built wasm32 SIMD codecs: ${path.relative(root, output)}`);
