#!/usr/bin/env bash
set -euo pipefail

if ! command -v make >/dev/null; then
    echo "GNU Make is required on PATH; see native/libav/README.md" >&2
    exit 1
fi

project=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$project/../.." && pwd)
source_dir="$root/out/libavjs-src"
output="$root/web/engine-js/codecs/libav"
artifacts="$root/out/libav"
major=6
upstream=https://github.com/Yahweasel/libav.js.git
variant=krkr-wmv

: "${EMSDK:?Load the installed SDK environment before building; see native/libav/README.md}"
expected=$(tr -d '\r\n' < "$root/native/emscripten-major.txt")
actual=$(tr -d '"\r\n' < "$EMSDK/upstream/emscripten/emscripten-version.txt")
if [ "${actual%%.*}" != "$expected" ]; then
    echo "Expected Emscripten $expected.x, found $actual" >&2
    exit 1
fi

tag=$(git ls-remote --tags --refs "$upstream" "v$major.*" |
    sed -n "s|.*refs/tags/\(v$major\.[0-9.]*\)$|\1|p" | sort -V | tail -n 1)
: "${tag:?No libav.js release found for the supported major version}"
changed=false
if [ ! -d "$source_dir" ]; then
    mkdir -p "$root/out"
    git clone --depth 1 --branch "$tag" "$upstream" "$source_dir"
fi
cd "$source_dir"
if ! git diff --quiet HEAD --; then
    echo "Local libav.js source edits found in $source_dir; preserve them as an explicit patch before building" >&2
    exit 1
fi
git fetch --depth 1 origin tag "$tag"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$tag^{commit}")" ]; then
    git checkout --detach "$tag"
    changed=true
fi

if $changed || [ ! -f node_modules/.bin/terser ]; then
    npm ci
fi
if $changed || [ ! -f "configs/configs/$variant/ffmpeg-config.txt" ] ||
   [ "$project/config-fragments.json" -nt "configs/configs/$variant/ffmpeg-config.txt" ]; then
    (cd configs && node mkconfig.js "$variant" "$(cat "$project/config-fragments.json")")
fi
versions=$(make --no-print-directory -s --eval='print-build-versions:;@echo $(LIBAVJS_VERSION) $(FFMPEG_VERSION) $(EMFT_VERSION)' print-build-versions)
read -r version ffmpeg emft <<< "$versions"
name="libav-$version-$variant"
echo "Building libav.js $version ($tag), FFmpeg $ffmpeg, emfiberthreads $emft, Emscripten $actual"
make --jobs="$(node -p 'require("node:os").availableParallelism()')" "dist/$name.mjs" "dist/$name.wasm.mjs"

mkdir -p "$output" "$artifacts/sources"
cp "dist/$name.mjs" "$output/libav-$variant.mjs"
cp "dist/$name.wasm.mjs" "$output/libav-$variant.wasm.mjs"
cp "dist/$name.wasm.wasm" "$output/libav-$variant.wasm.wasm"
cp "build/ffmpeg-$ffmpeg.tar.xz" "build/emfiberthreads-$emft.tar.gz" "$artifacts/sources/"
git archive --format=tar --prefix="libav.js-$version/" HEAD |
    xz -c > "$artifacts/sources/libav.js-$version.tar.xz"
cp "$project/config-fragments.json" "$project/build.sh" "$project/README.md" "$artifacts/sources/"
printf '{"libav":"%s","ffmpeg":"%s","emfiberthreads":"%s","emscripten":"%s"}\n' \
    "$version" "$ffmpeg" "$emft" "$actual" > "$artifacts/build-info.json"
echo "Built libav.js $version ($variant): $output"
