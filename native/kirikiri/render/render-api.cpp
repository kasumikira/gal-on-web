// C entry points for the rendering backend. Script bindings and browser verification
// pages access the backend through this API instead of touching C++ objects directly.
// id is a stable host-side handle; 0 is invalid.
#include "render/render.h"
#include "render/bitmap-surface.h"
#include "image/image-loader.h"
#include <algorithm>
#include <stdexcept>
#include <cstring>
#include <vector>

namespace {

using namespace gal::render;

// Index 0 is reserved for an invalid handle; the first texture handle is 1.
std::vector<Texture *> &Textures() {
    static std::vector<Texture *> textures{nullptr};
    return textures;
}

int Register(Texture *texture) {
    if (!texture) return 0;
    std::vector<Texture *> &textures = Textures();
    for (size_t i = 1; i < textures.size(); ++i) {
        if (!textures[i]) {
            textures[i] = texture;
            return static_cast<int>(i);
        }
    }
    textures.push_back(texture);
    return static_cast<int>(textures.size() - 1);
}

Texture *Lookup(int id) {
    std::vector<Texture *> &textures = Textures();
    if (id <= 0 || static_cast<size_t>(id) >= textures.size()) return nullptr;
    return textures[id];
}

// blend uses the tTVPBBBltMethod encoding directly. Blend enum values match it without
// a second mapping.
bool ValidBlend(int blend) { return blend >= 0 && blend <= static_cast<int>(Blend::PsExclusion); }

std::vector<std::unique_ptr<BitmapSurface>> &Bitmaps() {
    static std::vector<std::unique_ptr<BitmapSurface>> images(1);
    return images;
}

int RegisterBitmap(std::unique_ptr<BitmapSurface> image) {
    auto &images = Bitmaps();
    for (size_t i = 1; i < images.size(); ++i) {
        if (!images[i]) { images[i] = std::move(image); return static_cast<int>(i); }
    }
    images.push_back(std::move(image));
    return static_cast<int>(images.size() - 1);
}

BitmapSurface &Bitmap(int id) {
    auto &images = Bitmaps();
    if (id <= 0 || static_cast<size_t>(id) >= images.size() || !images[id])
        throw std::runtime_error("Invalid bitmap resource");
    return *images[id];
}

template<class F> int BitmapOperation(F operation) {
    Device::Get().SetError("");
    try { return operation(); }
    catch (const std::exception &error) { Device::Get().SetError(error.what()); return 0; }
}

} // namespace

namespace gal::render {
void ReleaseBitmapSurfaces() { Bitmaps().clear(); Bitmaps().resize(1); }
}

extern "C" {

int gal_render_initialize(int width, int height) {
    return Device::Get().Initialize(width, height) ? 1 : 0;
}

void gal_render_shutdown() {
    ReleaseBitmapSurfaces();
    for (Texture *texture : Textures()) {
        if (texture) texture->Release();
    }
    Textures().assign(1, nullptr);
    Device::Get().Shutdown();
}

void gal_render_resize(int width, int height) { Device::Get().Resize(width, height); }

int gal_render_max_texture() { return Device::Get().MaxTextureSize(); }

int gal_render_texture_create(int width, int height, int renderTarget) {
    return Register(Texture::Create(width, height, renderTarget != 0));
}

int gal_render_texture_from_pixels(int width, int height, int pitch, const void *pixels) {
    return Register(Texture::FromRGBA(pixels, width, height, pitch));
}

void gal_render_texture_release(int id) {
    std::vector<Texture *> &textures = Textures();
    if (id <= 0 || static_cast<size_t>(id) >= textures.size()) return;
    if (Texture *texture = textures[id]) {
        texture->Release();
        textures[id] = nullptr;
    }
}

int gal_render_texture_share(int id) {
    Texture *texture = Lookup(id);
    return texture ? Register(texture->Share()) : 0;
}

int gal_render_texture_clone(int id) {
    Texture *texture = Lookup(id);
    return texture ? Register(texture->Clone()) : 0;
}

int gal_render_texture_writable(int id) {
    std::vector<Texture *> &textures = Textures();
    Texture *texture = Lookup(id);
    if (!texture) return 0;
    Texture *writable = texture->EnsureWritable();
    if (!writable) return 0;
    if (writable == texture) return id;
    // Register the new texture before invalidating the old handle, so Register cannot
    // reuse the slot that was just freed.
    const int handle = Register(writable);
    textures[id] = nullptr;
    return handle;
}

int gal_render_texture_width(int id) {
    Texture *texture = Lookup(id);
    return texture ? texture->Width() : 0;
}

int gal_render_texture_height(int id) {
    Texture *texture = Lookup(id);
    return texture ? texture->Height() : 0;
}

int gal_render_texture_independent(int id) {
    Texture *texture = Lookup(id);
    return texture && texture->IsIndependent() ? 1 : 0;
}

void gal_render_texture_update(int id, int x, int y, int width, int height, const void *pixels) {
    if (Texture *texture = Lookup(id)) texture->Update(pixels, width * 4, Rect(x, y, x + width, y + height));
}

void gal_render_texture_read(int id, void *out) {
    if (Texture *texture = Lookup(id)) texture->ReadAll(out);
}

void gal_render_texture_fill(int id, int left, int top, int right, int bottom, unsigned int argb) {
    if (Texture *texture = Lookup(id)) Device::Get().Fill(texture, Rect(left, top, right, bottom), argb, nullptr);
}

void gal_render_texture_clear(int id) {
    if (Texture *texture = Lookup(id)) Device::Get().ClearTexture(texture, nullptr);
}

void gal_render_clear(float r, float g, float b, float a) { Device::Get().Clear(r, g, b, a); }

void gal_render_present(int id, int filter) {
    if (Texture *texture = Lookup(id))
        Device::Get().Present(texture, filter ? Filter::Linear : Filter::Nearest);
}

void gal_render_copy(int dst, int src, int left, int top, int right, int bottom, int x, int y, int filter) {
    Texture *target = Lookup(dst), *source = Lookup(src);
    if (!target || !source) return;
    Device::Get().Copy(target, source, Rect(left, top, right, bottom), x, y, nullptr,
                       filter ? Filter::Linear : Filter::Nearest);
}

void gal_render_scale(int dst, int src, int sl, int st, int sr, int sb, int dl, int dt, int dr, int db, int filter) {
    Texture *target = Lookup(dst), *source = Lookup(src);
    if (!target || !source) return;
    Device::Get().Scale(target, source, Rect(sl, st, sr, sb), Rect(dl, dt, dr, db), nullptr,
                        filter ? Filter::Linear : Filter::Nearest);
}

void gal_render_draw_rect(int dst, int src, int sl, int st, int sr, int sb, int x, int y,
                          int blend, int hda, int opacity, int clipL, int clipT, int clipR, int clipB, int filter) {
    Texture *target = Lookup(dst), *source = Lookup(src);
    if (!target || !source) return;
    if (!ValidBlend(blend)) return;
    const Rect clip(clipL, clipT, clipR, clipB);
    Device::Get().DrawRect(target, source, Rect(sl, st, sr, sb), x, y,
                           static_cast<Blend>(blend), hda != 0, opacity,
                           clip.Empty() ? nullptr : &clip, filter ? Filter::Linear : Filter::Nearest);
}

void gal_render_draw_quad(int dst, int src, int sl, int st, int sr, int sb, const float *quad,
                          int blend, int hda, int opacity, int clipL, int clipT, int clipR, int clipB, int filter) {
    Texture *target = Lookup(dst), *source = Lookup(src);
    if (!target || !source) return;
    if (!ValidBlend(blend)) return;
    const Rect clip(clipL, clipT, clipR, clipB);
    Device::Get().DrawQuad(target, source, Rect(sl, st, sr, sb), quad,
                           static_cast<Blend>(blend), hda != 0, opacity,
                           clip.Empty() ? nullptr : &clip, filter ? Filter::Linear : Filter::Nearest);
}

void gal_render_read_canvas(void *out) {
    Device &device = Device::Get();
    device.ResetRenderTarget();
    gal::gles::ReadCanvasPixels(0, 0, device.Width(), device.Height(), out);
}

unsigned long long gal_render_draw_count() { return Device::Get().DrawCount(); }

int gal_render_last_error(void *out, int capacity) {
    const std::string &error = Device::Get().LastError();
    const int length = static_cast<int>(error.size() < static_cast<size_t>(capacity) - 1 ? error.size()
                                                                                         : static_cast<size_t>(capacity) - 1);
    if (out && capacity > 0) {
        std::memcpy(out, error.data(), static_cast<size_t>(length));
        static_cast<char *>(out)[length] = 0;
    }
    return length;
}

void gal_render_context_lost() { Device::Get().OnContextLost(); }
void gal_render_context_restored() { Device::Get().OnContextRestored(); }

int gal_bitmap_create(int width, int height, uint32_t color) {
    return BitmapOperation([&] { return RegisterBitmap(BitmapSurface::Create(width, height, color)); });
}
int gal_bitmap_from_pixels(int width, int height, int pitch, const void *pixels) {
    return BitmapOperation([&] { return RegisterBitmap(BitmapSurface::FromRGBA(pixels, width, height, pitch)); });
}
int gal_bitmap_decode(const void *bytes, int size, int key) {
    return BitmapOperation([&] {
        if (!bytes || size <= 0) throw std::runtime_error("Image bytes are required");
        gal::image::MemoryStream stream(bytes, size);
        const auto image = gal::image::Decode(&stream, key, glmNormal);
        if (image.channels != 4) throw std::runtime_error("Normal image decode requires RGBA pixels");
        // Decode and upload share the same WASM buffer. Its lifetime ends here.
        return RegisterBitmap(BitmapSurface::FromRGBA(image.pixels.data(), image.width, image.height, image.Pitch()));
    });
}
int gal_bitmap_resize(int id, int width, int height, int keepImage, uint32_t fill) {
    return BitmapOperation([&] { Bitmap(id).SetSize(width, height, keepImage != 0, fill); return 1; });
}
int gal_bitmap_share(int id) {
    return BitmapOperation([&] { return RegisterBitmap(std::make_unique<BitmapSurface>(Bitmap(id))); });
}
void gal_bitmap_release(int id) {
    auto &images = Bitmaps();
    if (id > 0 && static_cast<size_t>(id) < images.size()) images[id].reset();
}
int gal_bitmap_width(int id) { return BitmapOperation([&] { return Bitmap(id).Width(); }); }
int gal_bitmap_height(int id) { return BitmapOperation([&] { return Bitmap(id).Height(); }); }
int gal_bitmap_fill(int id, int left, int top, int right, int bottom, uint32_t color) {
    return BitmapOperation([&] { Bitmap(id).Fill(Rect(left, top, right, bottom), color); return 1; });
}
int gal_bitmap_copy(int dst, int src, int left, int top, int right, int bottom, int x, int y) {
    return BitmapOperation([&] { Bitmap(dst).Copy(Bitmap(src), Rect(left, top, right, bottom), x, y); return 1; });
}
int gal_bitmap_draw(int dst, int src, int left, int top, int right, int bottom,
                    const double *matrix, int blend, int holdAlpha, int opacity,
                    int clipLeft, int clipTop, int clipRight, int clipBottom, int filter) {
    return BitmapOperation([&] {
        if (!matrix || !ValidBlend(blend)) throw std::runtime_error("Invalid bitmap drawing parameters");
        std::array<double, 6> transform;
        std::copy_n(matrix, transform.size(), transform.begin());
        Bitmap(dst).Draw(Bitmap(src), Rect(left, top, right, bottom), transform,
            static_cast<Blend>(blend), holdAlpha != 0, opacity,
            Rect(clipLeft, clipTop, clipRight, clipBottom), filter ? Filter::Linear : Filter::Nearest);
        return 1;
    });
}
int gal_bitmap_read(int id, void *pixels, int pitch) {
    return BitmapOperation([&] { Bitmap(id).ReadRGBA(pixels, pitch); return 1; });
}

} // extern "C"
