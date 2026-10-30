#pragma once

#include "tjs.h"
#include "visual/GraphicsLoaderIntf.h"
#include <cstdint>
#include <string>
#include <vector>

namespace gal::image {

// Decoded image. Rows follow image order: pixels[0] is the top-left pixel.
//
// The reference size callback allocates row width from the target bit depth only
// (32-bit or 8-bit tTVPBitmap). Pixel format only indicates whether output is opaque:
//   channels = 4: RGBA8 (opaque images have alpha = 255 and opaque = true)
//   channels = 1: 8-bit grayscale (province / mask)
struct Image
{
    int width = 0;
    int height = 0;
    int channels = 0;
    bool opaque = false;
    std::vector<uint8_t> pixels;

    bool Empty() const { return width <= 0 || height <= 0 || channels == 0; }
    size_t Pitch() const { return static_cast<size_t>(width) * channels; }
};

// Match the glmNormal path in TVPInternalLoadBitmap:
//   - Select a decoder by magic bytes.
//   - When keyidx has the form 0x00RRGGBB, generate alpha using that color key.
//   - When keyidx == clAdapt, use the most frequent first-row color as an adaptive key.
// Province/mask processing is handled by higher-level resource composition driven by
// the JS storage layer.
Image Decode(tTJSBinaryStream *src, tjs_int32 keyidx,
             tTVPGraphicLoadMode mode = glmNormal);

// Error object shared by the C API: formatted UTF-8 text.
const std::string &LastError();
void SetLastError(const std::string &message);

// In-memory byte stream. The reference loader only needs the seek/read interface of
// tTJSBinaryStream; storage still has a single JS implementation, and native receives bytes.
class MemoryStream final : public tTJSBinaryStream
{
public:
    MemoryStream(const void *bytes, size_t size)
        : data_(static_cast<const tjs_uint8 *>(bytes)), size_(size) {}

    tjs_uint64 Seek(tjs_int64 offset, tjs_int origin) override;
    tjs_uint Read(void *buffer, tjs_uint read_size) override;
    tjs_uint Write(const void *buffer, tjs_uint write_size) override;
    tjs_uint64 GetSize() override { return size_; }

private:
    const tjs_uint8 *data_;
    size_t size_;
    size_t position_ = 0;
};

} // namespace gal::image
