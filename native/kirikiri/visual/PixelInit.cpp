#include "tvpgl.h"
#include "PixelInit.h"

void TVPEnsureTVPGL() {
    // Shared initialization for the reference loaders, font rasterizer and
    // software province operations. There is only one copy of these tables.
    static const bool initialized = [] { TVPInitTVPGL(); return true; }();
    (void)initialized;
}
