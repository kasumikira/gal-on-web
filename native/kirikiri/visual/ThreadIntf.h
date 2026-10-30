#pragma once
#include "tjs.h"
// This WASM module executes one VM serially on the browser thread.
inline tjs_int TVPGetProcessorNum() { return 1; }
inline tjs_int TVPGetThreadNum() { return 1; }
template<class Task> void TVPExecThreadTask(tjs_int count, Task &&task) {
    for(tjs_int i = 0; i < count; ++i) task(i);
}
