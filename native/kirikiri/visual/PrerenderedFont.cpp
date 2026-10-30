// Adapted from Kirikiri's visual/PrerenderedFont.cpp.
// Copyright (C) W.Dee and contributors; see third_party/kirikiroid2/LICENSE.
#include "PrerenderedFont.h"
#include "BinaryStream.h"
#include "visual/PixelInit.h"
#include "visual/tvpgl.h"
#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <memory>

TJS::tTJSHashTable<TJS::ttstr, tTVPPrerenderedFont *> TVPPrerenderedFonts;

namespace {
uint32_t Read32(const uint8_t *p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
uint16_t Read16(const uint8_t *p) { return uint16_t(p[0]) | uint16_t(p[1]) << 8; }
}

tTVPPrerenderedFont::tTVPPrerenderedFont(TJS::tTJSBinaryStream &stream) { Load(stream); }
tTVPPrerenderedFont::tTVPPrerenderedFont(const TJS::ttstr &storage) : Storage(storage) {
    std::unique_ptr<TJS::tTJSBinaryStream> stream(TVPCreateStream(storage, TJS_BS_READ));
    Load(*stream);
    TVPPrerenderedFonts.Add(Storage, this);
}
tTVPPrerenderedFont::~tTVPPrerenderedFont() {
    if (!Storage.IsEmpty()) TVPPrerenderedFonts.Delete(Storage);
}
void tTVPPrerenderedFont::Load(TJS::tTJSBinaryStream &stream) {
    const auto length = stream.GetSize();
    if (length < 36 || length > UINT32_MAX)
        throw TJS::eTJSError(TJS::ttstr("Invalid prerendered font file"));
    Image.resize(static_cast<size_t>(length));
    stream.ReadBuffer(Image.data(), static_cast<tjs_uint>(length));
    if (std::memcmp("TVP pre-rendered font\x1a", Image.data(), 22))
        throw TJS::eTJSError(TJS::ttstr("Invalid prerendered font file"));
    if (Image[23] != 2)
        throw TJS::eTJSError(TJS::ttstr("Prerendered font is not a 16-bit Unicode font"));
    Version = Image[22];
    if (Version != 0 && Version != 1)
        throw TJS::eTJSError(TJS::ttstr("Invalid prerendered font header version"));
    IndexCount = Read32(Image.data() + 24);
    const uint32_t chars = Read32(Image.data() + 28), items = Read32(Image.data() + 32);
    if (uint64_t(chars) + uint64_t(IndexCount) * 2 > length ||
        uint64_t(items) + uint64_t(IndexCount) * sizeof(tTVPPrerenderedCharacterItem) > length)
        throw TJS::eTJSError(TJS::ttstr("Truncated prerendered font index"));
    ChIndex = Image.data() + chars;
    Index = reinterpret_cast<const tTVPPrerenderedCharacterItem *>(Image.data() + items);
}

const tTVPPrerenderedCharacterItem *tTVPPrerenderedFont::Find(tjs_char ch) const {
    // Reference binary search, retaining the UTF-16 character/index contract.
    if (!IndexCount) return nullptr;
    uint32_t s = 0, e = IndexCount;
    while (true) {
        const uint32_t d = e - s;
        if (d <= 1) return Read16(ChIndex + s * 2) == ch ? Index + s : nullptr;
        const uint32_t m = s + (d >> 1);
        if (Read16(ChIndex + m * 2) > ch) e = m;
        else s = m;
    }
}

void tTVPPrerenderedFont::Retrieve(const tTVPPrerenderedCharacterItem *item,
                                 uint8_t *buffer, int pitch) const {
    if (!item->Width || !item->Height) return;
    if (!buffer || pitch < item->Width)
        throw TJS::eTJSError(TJS::ttstr("Invalid prerendered glyph output pitch"));
    if (item->Offset >= Image.size()) throw TJS::eTJSError(TJS::ttstr("Truncated prerendered glyph"));
    const auto *ptr = Image.data() + item->Offset;
    const auto *end = Image.data() + Image.size();
    auto *dest = buffer;
    const auto *limit = buffer + size_t(item->Width) * item->Height;
    // Both reference RLE versions repeat the preceding coverage value.
    while (dest < limit) {
        if (ptr == end) throw TJS::eTJSError(TJS::ttstr("Truncated prerendered glyph"));
        const uint8_t marker = *ptr++;
        if ((Version == 0 && marker == 0x41) || (Version == 1 && marker >= 0x41)) {
            if (Version == 0 && ptr == end) throw TJS::eTJSError(TJS::ttstr("Truncated prerendered glyph"));
            const unsigned count = Version == 0 ? *ptr++ : marker - 0x40;
            if (dest == buffer || count > size_t(limit - dest))
                throw TJS::eTJSError(TJS::ttstr("Invalid prerendered glyph run"));
            std::fill_n(dest, count, dest[-1]);
            dest += count;
        } else {
            *dest++ = marker;
        }
    }
    // TVPUpscale65_255: 0..63 -> value*4, 64 -> 255.
    TVPEnsureTVPGL();
    TVPUpscale65_255(buffer, item->Width * item->Height);
    // Expand packed rows backwards, as in the reference implementation.
    for (int y = item->Height - 1; y >= 0; --y)
        std::memmove(buffer + size_t(y) * pitch, buffer + size_t(y) * item->Width, item->Width);
}
