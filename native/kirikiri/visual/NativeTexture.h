#pragma once
#include "RenderManager.h"
#include "render/bitmap-surface.h"

// Platform implementation of the reference iTVPTexture2D contract. CPU storage
// exists only for explicit scanline access and software province bitmaps.
class tTVPGLESTexture final : public iTVPTexture2D {
public:
    tTVPGLESTexture(unsigned width, unsigned height, TVPTextureFormat::e format);
    tTVPGLESTexture(const tTVPGLESTexture &source);
    TVPTextureFormat::e GetFormat() const override { return Format; }
    const void *GetScanLineForRead(tjs_uint line) override;
    void *GetScanLineForWrite(tjs_uint line) override;
    tjs_int GetPitch() const override { return Width * (Format == TVPTextureFormat::Gray ? 1 : 4); }
    void Update(const void *pixels, TVPTextureFormat::e format, int pitch, const tTVPRect &rect) override;
    uint32_t GetPoint(int x, int y) override;
    void SetPoint(int x, int y, uint32_t color) override;
    bool IsStatic() override { return false; }
    bool IsOpaque() override { return Opaque; }
    void SetSize(unsigned width, unsigned height) override;
    gal::render::BitmapSurface &GetSurface();
    void DidRender();
private:
    void ReadPixels();
    TVPTextureFormat::e Format;
    bool Opaque = false;
    bool PixelsValid = false;
    std::unique_ptr<gal::render::BitmapSurface> Surface;
    std::vector<uint8_t> Pixels;
};
