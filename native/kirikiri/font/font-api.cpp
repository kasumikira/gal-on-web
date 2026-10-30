#include "visual/PrerenderedFont.h"
#include "image/image-loader.h"
#include <algorithm>
#include <cstring>
#include <memory>
#include <string>
#include <stdexcept>

namespace {
struct ReleaseFont { void operator()(tTVPPrerenderedFont *font) const { if (font) font->Release(); } };
using FontOwner = std::unique_ptr<tTVPPrerenderedFont, ReleaseFont>;
std::vector<FontOwner> fonts(1);
std::string error;
tTVPPrerenderedFont &Font(int id) {
    if (id <= 0 || size_t(id) >= fonts.size() || !fonts[id])
        throw std::runtime_error("Invalid prerendered font resource");
    return *fonts[id];
}
template<class F> int Operation(F operation, int failure = -1) {
    error.clear();
    try { return operation(); }
    catch (const std::exception &e) { error = e.what(); return failure; }
}
}

extern "C" {
int gal_font_open(const void *bytes, int size) {
    return Operation([&] {
        if (!bytes || size <= 0) throw std::runtime_error("Prerendered font bytes are required");
        gal::image::MemoryStream stream(bytes, size);
        FontOwner font(new tTVPPrerenderedFont(stream));
        for (size_t i = 1; i < fonts.size(); ++i) {
            if (!fonts[i]) { fonts[i] = std::move(font); return int(i); }
        }
        fonts.push_back(std::move(font));
        return int(fonts.size() - 1);
    }, 0);
}
void gal_font_release(int id) {
    if (id > 0 && size_t(id) < fonts.size()) fonts[id].reset();
}
int gal_font_glyph_metrics(int id, unsigned character, int32_t *metrics) {
    return Operation([&] {
        if (!metrics) throw std::runtime_error("Glyph metrics output is required");
        const auto *item = Font(id).Find(static_cast<tjs_char>(character));
        if (!item) return 0;
        const int32_t values[] = {item->Width, item->Height, item->OriginX, item->OriginY,
                                  item->IncX, item->IncY, item->Inc, item->Reserved};
        std::copy_n(values, 8, metrics);
        return 1;
    });
}
int gal_font_glyph_read(int id, unsigned character, uint8_t *pixels, int pitch) {
    return Operation([&] {
        const auto &font = Font(id);
        const auto *item = font.Find(static_cast<tjs_char>(character));
        if (!item) return 0;
        font.Retrieve(item, pixels, pitch);
        return 1;
    });
}
int gal_font_last_error(char *out, int capacity) {
    if (out && capacity > 0) {
        const auto count = std::min(size_t(capacity - 1), error.size());
        std::memcpy(out, error.data(), count);
        out[count] = 0;
    }
    return int(error.size());
}
}
