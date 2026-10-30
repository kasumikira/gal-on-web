#include "NativeTexture.h"
#include "Platform.h"
#include <algorithm>
#include <cstring>

namespace {
// Single adapter between the two channel conventions:
//   * gal::render surfaces/textures use the script-side 0xAARRGGBB numeric
//     layout (GPU bytes are R,G,B,A);
//   * iTVPTexture2D scanlines use RGBA bytes (numeric 0xAABBGGRR on WASM).
// GetPoint/SetPoint adapt the surface's color integers to that texture layout.
// The script-facing read conversion is in TVPFromActualColor; unlike the
// reference implementation, it swaps red and blue on reads.
uint32_t ReverseRGB(uint32_t color) {
    return (color & 0xff00ff00) | ((color & 255) << 16) | ((color >> 16) & 255);
}
}

namespace { std::vector<iTVPTexture2D *> PendingTextures; }
void iTVPTexture2D::Release() {
    // Original LayerBitmap keeps a raw reftar across IndependNoCopy. Preserve
    // the reference engine's deferred destruction boundary for that draw.
    if (RefCount == 1) PendingTextures.push_back(this);
    else --RefCount;
}
void iTVPTexture2D::RecycleProcess() {
    for (auto *texture : PendingTextures) delete texture;
    PendingTextures.clear();
}

tTVPGLESTexture::tTVPGLESTexture(unsigned width, unsigned height, TVPTextureFormat::e format)
    : iTVPTexture2D(width, height), Format(format) {
    if (format != TVPTextureFormat::Gray && format != TVPTextureFormat::RGBA && format != TVPTextureFormat::RGB)
        TVPThrowExceptionMessage(TVPInvalidBPP);
    if (Format == TVPTextureFormat::Gray) {
        Pixels.resize(size_t(width) * height);
        PixelsValid = true;
    } else {
        Surface = gal::render::BitmapSurface::Create(width, height);
    }
}

tTVPGLESTexture::tTVPGLESTexture(const tTVPGLESTexture &source)
    : iTVPTexture2D(source.Width, source.Height), Format(source.Format), Opaque(source.Opaque) {
    if (source.Surface) Surface = std::make_unique<gal::render::BitmapSurface>(*source.Surface);
    else { Pixels = source.Pixels; PixelsValid = true; }
}

void tTVPGLESTexture::ReadPixels() {
    if (PixelsValid) return;
    Pixels.resize(size_t(GetPitch()) * Height);
    if (Format == TVPTextureFormat::Gray) {
        std::vector<uint8_t> rgba(size_t(Width) * Height * 4);
        GetSurface().ReadRGBA(rgba.data(), Width * 4);
        for (size_t i = 0; i < Pixels.size(); ++i) Pixels[i] = rgba[i * 4];
    } else GetSurface().ReadRGBA(Pixels.data(), GetPitch());
    PixelsValid = true;
}

const void *tTVPGLESTexture::GetScanLineForRead(tjs_uint line) {
    if (line >= unsigned(Height)) TVPThrowExceptionMessage(TVPScanLineRangeOver, ttstr(tjs_int(line)), Height - 1);
    ReadPixels();
    return Pixels.data() + size_t(line) * GetPitch();
}

void *tTVPGLESTexture::GetScanLineForWrite(tjs_uint line) {
    const auto *row = GetScanLineForRead(line);
    Surface.reset();
    Opaque = false;
    return const_cast<void *>(row);
}

gal::render::BitmapSurface &tTVPGLESTexture::GetSurface() {
    if (!Surface) {
        if (Format == TVPTextureFormat::Gray) {
            std::vector<uint8_t> rgba(size_t(Width) * Height * 4);
            for (size_t i = 0; i < Pixels.size(); ++i) {
                rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = Pixels[i];
                rgba[i * 4 + 3] = 255;
            }
            Surface = gal::render::BitmapSurface::FromRGBA(rgba.data(), Width, Height, Width * 4);
        } else Surface = gal::render::BitmapSurface::FromRGBA(Pixels.data(), Width, Height, GetPitch());
    }
    return *Surface;
}

void tTVPGLESTexture::DidRender() {
    PixelsValid = false;
    std::vector<uint8_t>().swap(Pixels);
    Opaque = false;
}

void tTVPGLESTexture::Update(const void *pixels, TVPTextureFormat::e format, int pitch, const tTVPRect &rect) {
    if (format != Format) TVPThrowExceptionMessage(TVPInvalidBPP);
    if (rect.is_empty()) return;
    if (!pitch) pitch = rect.get_width() * (Format == TVPTextureFormat::Gray ? 1 : 4);
    if (Format == TVPTextureFormat::Gray) {
        ReadPixels();
        for (int y = rect.top; y < rect.bottom; ++y)
            std::memcpy(Pixels.data() + size_t(y) * GetPitch() + rect.left,
                        static_cast<const uint8_t *>(pixels) + size_t(y - rect.top) * pitch, rect.get_width());
        Surface.reset();
    } else {
        GetSurface().Update(pixels, pitch, {rect.left, rect.top, rect.right, rect.bottom});
        DidRender();
    }
}

uint32_t tTVPGLESTexture::GetPoint(int x, int y) {
    if (x < 0 || y < 0 || x >= Width || y >= Height) TVPThrowExceptionMessage(TVPOutOfRectangle);
    if (Format == TVPTextureFormat::Gray) {
        ReadPixels();
        return Pixels[size_t(y) * Width + x];
    }
    if (PixelsValid) {
        uint32_t color;
        std::memcpy(&color, Pixels.data() + size_t(y) * GetPitch() + x * 4, 4);
        return color;
    }
    return ReverseRGB(GetSurface().Point(x, y));
}

void tTVPGLESTexture::SetPoint(int x, int y, uint32_t color) {
    if (x < 0 || y < 0 || x >= Width || y >= Height) TVPThrowExceptionMessage(TVPOutOfRectangle);
    if (Format == TVPTextureFormat::Gray) {
        ReadPixels();
        Pixels[size_t(y) * Width + x] = color;
        Surface.reset();
    } else {
        GetSurface().Fill({x, y, x + 1, y + 1}, ReverseRGB(color));
        DidRender();
    }
}

void tTVPGLESTexture::SetSize(unsigned width, unsigned height) {
    if (Width == int(width) && Height == int(height)) return;
    Surface.reset();
    Width = width; Height = height;
    Pixels.assign(size_t(GetPitch()) * height, 0);
    PixelsValid = true;
    Opaque = false;
}
