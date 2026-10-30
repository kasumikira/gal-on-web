#pragma once
#include "Platform.h"
#include <cstdlib>

// Browser platform allocation behind the reference bitmap interface.
class tTVPBitmapBitsAlloc {
public:
    static void *Alloc(tjs_uint size, tjs_uint, tjs_uint) {
        auto *bits = std::malloc(size);
        if (!bits) TVPThrowExceptionMessage(TVPCannotAllocateBitmapBits, TJS_W("allocating bitmap bits"), ttstr(tjs_int64(size)));
        return bits;
    }
    static void Free(void *bits) { std::free(bits); }
};
