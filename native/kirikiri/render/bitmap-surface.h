#pragma once
#include "render/render.h"
#include <array>

namespace gal::render {

// Logical LayerBitmap storage. GPU tiles include a one-pixel sampling border;
// coordinates and clipping remain in the logical image's coordinate system.
class BitmapSurface {
public:
    struct Coordinate { double x, y; };
    struct MeshVertex { double x, y, w = 1.0; std::vector<Coordinate> texture; };
    static std::unique_ptr<BitmapSurface> Create(int width, int height, uint32_t color = 0);
    static std::unique_ptr<BitmapSurface> FromRGBA(const void *pixels, int width, int height, int pitch);
    BitmapSurface(const BitmapSurface &source);
    int Width() const { return width_; }
    int Height() const { return height_; }
    void SetSize(int width, int height, bool keepImage, uint32_t fill);
    void Fill(const Rect &rect, uint32_t color);
    uint32_t Point(int x, int y) const;
    void Update(const void *pixels, int pitch, const Rect &rect);
    void Draw(const BitmapSurface &source, const Rect &sourceRect,
              const std::array<double, 6> &matrix, Blend blend, bool holdAlpha,
              int opacity, const Rect &clip, Filter filter);
    void Draw(const BitmapSurface &source, const Rect &sourceRect,
              const std::array<double, 6> &matrix, Method *method, int opacity,
              const Rect &clip, Filter filter, const std::function<void()> &applyParameters = {},
              const BitmapSurface *referenceTarget = nullptr);
    void Copy(const BitmapSurface &source, const Rect &sourceRect, int x, int y);
    void DrawTwo(const BitmapSurface &first, const Rect &firstRect,
                 const BitmapSurface &second, const Rect &secondRect,
                 const Rect &destination, Method *method, int opacity,
                 const std::function<void()> &applyParameters);
    void DrawMesh(const std::vector<const BitmapSurface *> &sources,
                  const std::vector<MeshVertex> &vertices, const Rect &clip,
                  Method *method, int opacity, Filter filter,
                  const std::function<void()> &applyParameters = {},
                  const BitmapSurface *referenceTarget = nullptr);
    void ReadRGBA(void *out, int pitch) const;
    void Present(int width, int height) const;
private:
    struct ReleaseTexture { void operator()(Texture *texture) const { if (texture) texture->Release(); } };
    using TextureOwner = std::unique_ptr<Texture, ReleaseTexture>;
    struct Tile { Rect logical, storage; TextureOwner texture; };
    BitmapSurface(int width, int height);
    void Writable(Tile &tile);
    int width_, height_;
    std::vector<Tile> tiles_;
};

// Resource registry used by the C ABI. Shutdown precedes Device::Shutdown.
void ReleaseBitmapSurfaces();

} // namespace gal::render

extern "C" {
int gal_bitmap_create(int width, int height, uint32_t color);
int gal_bitmap_from_pixels(int width, int height, int pitch, const void *pixels);
int gal_bitmap_decode(const void *bytes, int size, int key);
int gal_bitmap_resize(int id, int width, int height, int keepImage, uint32_t fill);
int gal_bitmap_share(int id);
void gal_bitmap_release(int id);
int gal_bitmap_width(int id);
int gal_bitmap_height(int id);
int gal_bitmap_fill(int id, int left, int top, int right, int bottom, uint32_t color);
int gal_bitmap_copy(int dst, int src, int left, int top, int right, int bottom, int x, int y);
int gal_bitmap_draw(int dst, int src, int left, int top, int right, int bottom,
                    const double *matrix, int blend, int holdAlpha, int opacity,
                    int clipLeft, int clipTop, int clipRight, int clipBottom, int filter);
int gal_bitmap_read(int id, void *pixels, int pitch);
}
