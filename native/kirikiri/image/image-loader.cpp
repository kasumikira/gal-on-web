#include "image-loader.h"
#include "MsgIntf.h"
#include "visual/PixelInit.h"
#include <cstring>

#include <algorithm>
#include <cstdio>
#include <cstdlib>

namespace gal::image {

namespace {
std::string Error;
}
const std::string &LastError() { return Error; }
void SetLastError(const std::string &message) { Error = message; }

tjs_uint64 MemoryStream::Seek(tjs_int64 offset, tjs_int origin) {
    int64_t base = 0;
    switch(origin) {
        case TJS_BS_SEEK_SET: base = 0; break;
        case TJS_BS_SEEK_CUR: base = static_cast<int64_t>(position_); break;
        case TJS_BS_SEEK_END: base = static_cast<int64_t>(size_); break;
        default: TVPThrowExceptionMessage(TVPReadError);
    }
    int64_t next = base + offset;
    if(next < 0) next = 0;
    if(next > static_cast<int64_t>(size_)) next = static_cast<int64_t>(size_);
    position_ = static_cast<size_t>(next);
    return position_;
}

tjs_uint MemoryStream::Read(void *buffer, tjs_uint read_size) {
    size_t available = size_ - position_;
    size_t take = std::min<size_t>(read_size, available);
    if(take) {
        std::memcpy(buffer, data_ + position_, take);
        position_ += take;
    }
    return static_cast<tjs_uint>(take);
}

tjs_uint MemoryStream::Write(const void *, tjs_uint) {
    TVPThrowExceptionMessage(TVPReadError);
}

//---------------------------------------------------------------------------
// Decode target.
//---------------------------------------------------------------------------
namespace {

struct Target
{
    Image *image;
    int pitch = 0;
};

int SizeCallback(void *callbackdata, tjs_uint w, tjs_uint h,
                 tTVPGraphicPixelFormat format) {
    Target *target = static_cast<Target *>(callbackdata);
    // Match TVPLoadGraphic_SizeCallback: row width depends only on the target bit depth;
    // format is used only to mark opaque output (gpfRGB / gpfLuminance).
    int channels = 1;
    bool opaque = false;
    switch(format) {
        case gpfRGBA: channels = 4; break;
        case gpfRGB: channels = 4; opaque = true; break;
        case gpfLuminance:
        case gpfPalette: channels = 1; opaque = true; break;
        default: TVPThrowExceptionMessage(TVPUnsupportedColorType);
    }
    target->image->opaque = opaque;
    // Match the reference: treat images over 16M pixels as malformed input to avoid
    // unexpectedly large allocations.
    if(w == 0 || h == 0 || static_cast<uint64_t>(w) * h > 0x1000000ull)
        TVPThrowExceptionMessage(TVPTooLargeImage);
    target->image->width = static_cast<int>(w);
    target->image->height = static_cast<int>(h);
    target->image->channels = channels;
    target->pitch = static_cast<int>(w) * channels;
    target->image->pixels.resize(static_cast<size_t>(target->pitch) * h);
    return target->pitch;
}

void *ScanLineCallback(void *callbackdata, tjs_int y) {
    Target *target = static_cast<Target *>(callbackdata);
    if(y < 0) return nullptr; // Signal that the previous row has been completed.
    if(y >= target->image->height) return nullptr;
    return target->image->pixels.data() +
        static_cast<size_t>(target->pitch) * static_cast<size_t>(y);
}

// Match GraphicsLoaderIntf.cpp TVPMakeAlphaFromKey: matching colors get alpha = 0.
void MakeAlphaFromKey(tjs_uint32 *dest, tjs_int len, tjs_uint32 key) {
    key &= 0xffffff;
    for(tjs_int i = 0; i < len; ++i) {
        tjs_uint32 value = dest[i] & 0xffffff;
        dest[i] = value == key ? value : (value | 0xff000000);
    }
}

// Match GraphicsLoaderIntf.cpp TVPMakeAlphaFromAdaptiveColor:
// use the most frequent color in the first row as the color key.
void MakeAlphaFromAdaptiveColor(Image &image) {
    if(image.channels != 4) return;
    const int width = image.width;
    tjs_uint32 *line = reinterpret_cast<tjs_uint32 *>(image.pixels.data());
    std::vector<tjs_uint32> colors(line, line + width);
    for(tjs_uint32 &color : colors) color &= 0xffffff;
    std::sort(colors.begin(), colors.end());

    tjs_int maxLength = 0;
    tjs_uint32 maxColor = 0;
    tjs_uint32 previous = 0xffffffffu;
    tjs_int length = 0;
    for(tjs_uint32 color : colors) {
        if(color != previous) {
            if(maxLength < length) {
                maxLength = length;
                maxColor = previous;
                length = 0;
            }
        } else {
            length++;
        }
        previous = color;
    }
    if(maxLength < length) {
        maxLength = length;
        maxColor = previous;
    }
    if(maxColor == 0xffffffffu) maxColor = 0; // Use black when no color was found, as in the reference.

    for(int y = 0; y < image.height; ++y) {
        tjs_uint32 *row = reinterpret_cast<tjs_uint32 *>(
            image.pixels.data() + static_cast<size_t>(y) * image.Pitch());
        MakeAlphaFromKey(row, width, maxColor);
    }
}

// Match GraphicsLoaderIntf.cpp TVPLoadGraphicRouter: select a decoder by magic bytes.
void LoadRouted(void *target, tTVPGraphicSizeCallback size,
                tTVPGraphicScanLineCallback row, tTJSBinaryStream *stream,
                tjs_int key, tTVPGraphicLoadMode mode) {
    TVPLoadGraphicRouter(nullptr, target, size, row, nullptr, stream, key, mode);
}

} // namespace

Image Decode(tTJSBinaryStream *src, tjs_int32 keyidx,
             tTVPGraphicLoadMode mode) {
    TVPEnsureTVPGL();
    Image image;
    Target target{ &image };

    // Only palette indices are handled by the format decoder; apply RGB color keys
    // after RGBA decoding.
    bool adaptive = keyidx == static_cast<tjs_int32>(0x01ffffff);
    const auto key = static_cast<tjs_uint32>(keyidx);
    const bool paletteKey = (key & 0xff000000u) == 0x03000000u;
    const tjs_int32 handlerKey = paletteKey ? (key & 0xff) : -1;

    LoadRouted(&target, SizeCallback, ScanLineCallback, src, handlerKey, mode);

    if(adaptive && mode == glmNormal) {
        MakeAlphaFromAdaptiveColor(image);
        image.opaque = false;
    }

    // The reference applies color keys in the ScanLine callback. Here, apply them once
    // after decoding the full image; the resulting pixel layout is identical.
    if((key & 0xff000000u) == 0 && mode == glmNormal && image.channels == 4) {
        // Little-endian RGBA bytes correspond to 0xAABBGGRR, not the script's 0xAARRGGBB.
        const tjs_uint32 rgbaKey = ((key & 0xff) << 16) | (key & 0xff00) | ((key >> 16) & 0xff);
        for(int y = 0; y < image.height; ++y) {
            tjs_uint32 *row = reinterpret_cast<tjs_uint32 *>(
                image.pixels.data() + static_cast<size_t>(y) * image.Pitch());
            MakeAlphaFromKey(row, image.width,
                             rgbaKey);
        }
        image.opaque = false;
    }
    return image;
}

} // namespace gal::image
