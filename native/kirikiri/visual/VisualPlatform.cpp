#include "Platform.h"
#include "SysInitIntf.h"
#include "PixelInit.h"
#include "StorageIntf.h"
#include <algorithm>
#include <emscripten/emscripten.h>
#include <utility>
#include <vector>

namespace {
auto &ExitHandlers() {
    static std::vector<std::pair<tjs_int, void (*)()>> handlers;
    return handlers;
}
bool VisualShutdown = false;
}
void TVPAddAtExitHandler(tjs_int priority, void (*handler)()) {
    if (!VisualShutdown) ExitHandlers().emplace_back(priority, handler);
}
void TVPShutdownVisual() {
    if (VisualShutdown) return;
    VisualShutdown = true;
    auto &handlers = ExitHandlers();
    std::stable_sort(handlers.begin(), handlers.end(), [](const auto &a, const auto &b) { return a.first < b.first; });
    for (const auto &[priority, handler] : handlers) handler();
    handlers.clear();
}
void TVPInitWindowOptions() { TVPEnsureTVPGL(); }
tjs_uint64 TVPGetTickCount() { return static_cast<tjs_uint64>(emscripten_get_now()); }
// The browser supplies a monotonic 64-bit clock; no rollover watcher is needed.
void TVPStartTickCount() {}
tjs_uint32 TVPGetRoughTickCount32() { return static_cast<tjs_uint32>(TVPGetTickCount()); }
tjs_int TVPDrawThreadNum = 1;

// The reference non-Windows backend resolves the resource, then uses the
// default cursor; its native cursor-file loader is Windows-only.
tjs_int TVPGetCursor(const ttstr &name) {
    TVPSearchPlacedPath(name);
    return 0;
}
