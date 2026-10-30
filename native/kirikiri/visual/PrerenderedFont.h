// Adapted from Kirikiri's visual/PrerenderedFont.h/.cpp.
// Copyright (C) W.Dee and contributors; see third_party/kirikiroid2/LICENSE.
#pragma once
#include "tjs.h"
#include "tjsHashSearch.h"
#include <cstdint>
#include <vector>

#pragma pack(push, 1)
struct tTVPPrerenderedCharacterItem {
    uint32_t Offset;
    uint16_t Width, Height;
    int16_t OriginX, OriginY, IncX, IncY, Inc;
    uint16_t Reserved;
};
#pragma pack(pop)

// Storage names and file access belong to the shared JS storage service.
// The caller supplies its stream; this object owns the loaded font image.
class tTVPPrerenderedFont {
public:
    explicit tTVPPrerenderedFont(TJS::tTJSBinaryStream &stream);
    explicit tTVPPrerenderedFont(const TJS::ttstr &storage);
    ~tTVPPrerenderedFont();
    void AddRef() { ++RefCount; }
    void Release() { if (--RefCount == 0) delete this; }
    tTVPPrerenderedFont(const tTVPPrerenderedFont &) = delete;
    tTVPPrerenderedFont &operator=(const tTVPPrerenderedFont &) = delete;
    const tTVPPrerenderedCharacterItem *Find(tjs_char character) const;
    void Retrieve(const tTVPPrerenderedCharacterItem *item, uint8_t *buffer, int pitch) const;
private:
    void Load(TJS::tTJSBinaryStream &stream);
    TJS::ttstr Storage;
    unsigned RefCount = 1;
    std::vector<uint8_t> Image;
    int Version;
    uint32_t IndexCount;
    const uint8_t *ChIndex;
    const tTVPPrerenderedCharacterItem *Index;
};

extern TJS::tTJSHashTable<TJS::ttstr, tTVPPrerenderedFont *> TVPPrerenderedFonts;

extern "C" {
int gal_font_open(const void *bytes, int size);
void gal_font_release(int id);
// 1 = found, 0 = absent, -1 = error. Output is eight int32 metrics:
// width, height, originX, originY, incX, incY, inc, reserved.
int gal_font_glyph_metrics(int id, unsigned character, int32_t *metrics);
// Coverage is 0..255; rows have the caller's pitch. Empty glyphs need no output.
int gal_font_glyph_read(int id, unsigned character, uint8_t *pixels, int pitch);
int gal_font_last_error(char *out, int capacity);
}
