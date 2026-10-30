// C ABI for image decoding. JS only reads the bytes (the sole storage implementation).
// Decoding, color-keying, and grayscale conversion happen in native code; pixels stay
// in WASM linear memory and are passed directly to gl.texImage2D without another copy.

#include "image-loader.h"

#include <algorithm>
#include <memory>
#include <vector>

namespace {

std::vector<std::unique_ptr<gal::image::Image>> &Handles() {
    // Reserve index 0 for an invalid handle.
    static std::vector<std::unique_ptr<gal::image::Image>> handles(1);
    return handles;
}

gal::image::Image *Lookup(int handle) {
    auto &handles = Handles();
    if(handle <= 0 || static_cast<size_t>(handle) >= handles.size()) return nullptr;
    return handles[handle].get();
}

} // namespace

extern "C" {

// mode: 0 = glmNormal, 1 = glmPalettized, 2 = glmGrayscale
int gal_image_decode(const void *bytes, int size, int key, int mode) {
    gal::image::SetLastError("");
    if(!bytes || size <= 0) return 0;
    try {
        gal::image::MemoryStream stream(bytes, static_cast<size_t>(size));
        auto image = std::make_unique<gal::image::Image>(
            gal::image::Decode(&stream, key,
                               static_cast<tTVPGraphicLoadMode>(mode)));
        if(image->Empty()) return 0;
        auto &handles = Handles();
        for(size_t i = 1; i < handles.size(); ++i) {
            if(!handles[i]) {
                handles[i] = std::move(image);
                return static_cast<int>(i);
            }
        }
        handles.push_back(std::move(image));
        return static_cast<int>(handles.size() - 1);
    } catch(const std::exception &error) {
        gal::image::SetLastError(error.what());
        return 0;
    }
}

int gal_image_width(int handle) {
    auto *image = Lookup(handle);
    return image ? image->width : 0;
}

int gal_image_height(int handle) {
    auto *image = Lookup(handle);
    return image ? image->height : 0;
}

int gal_image_channels(int handle) {
    auto *image = Lookup(handle);
    return image ? image->channels : 0;
}

const void *gal_image_pixels(int handle) {
    auto *image = Lookup(handle);
    return image ? image->pixels.data() : nullptr;
}

void gal_image_release(int handle) {
    auto &handles = Handles();
    if(handle <= 0 || static_cast<size_t>(handle) >= handles.size()) return;
    handles[handle].reset();
}

// Return the number of UTF-8 bytes. If the capacity is insufficient, still return
// the required length so the caller can resize its buffer.
int gal_image_last_error(char *out, int capacity) {
    const std::string &message = gal::image::LastError();
    const int length = static_cast<int>(message.size());
    if(out && capacity > 0) {
        const int copy = std::min(capacity - 1, length);
        std::memcpy(out, message.data(), static_cast<size_t>(copy));
        out[copy] = '\0';
    }
    return length;
}

} // extern "C"
