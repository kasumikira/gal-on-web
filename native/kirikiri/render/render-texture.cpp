#include "render/render.h"
#include <cstring>

namespace gal::render {

using namespace gal::gles;

Texture::Texture(int width, int height, bool renderTarget)
    : width_(width), height_(height), renderTarget_(renderTarget) {
    name_ = GenTexture();
    // Texture parameters are set when binding. Ensure a newly created texture has complete
    // parameters here to avoid undefined results from sampling an incomplete texture.
    BindTexture(kTexture2D, name_);
    State().texture = name_;
    TexParameteri(kTexture2D, kTextureWrapS, kClampToEdge);
    TexParameteri(kTexture2D, kTextureWrapT, kClampToEdge);
    TexParameteri(kTexture2D, kTextureMinFilter, kLinear);
    TexParameteri(kTexture2D, kTextureMagFilter, kLinear);
}

Texture::~Texture() {
    if (name_) {
        Device::Get().ForgetTexture(name_);
        if (State().texture == name_) State().texture = 0;
        DeleteTexture(name_);
    }
}

Texture *Texture::Create(int width, int height, bool renderTarget) {
    if (width <= 0 || height <= 0) return nullptr;
    if (width > MaxTextureSize() || height > MaxTextureSize()) return nullptr;
    Texture *texture = new Texture(width, height, renderTarget);
    TexImage2D(width, height, nullptr);
    return texture;
}

Texture *Texture::FromRGBA(const void *pixels, int width, int height, int pitch) {
    if (!pixels || width <= 0 || height <= 0) return nullptr;
    if (width > MaxTextureSize() || height > MaxTextureSize()) return nullptr;
    Texture *texture = new Texture(width, height, false);
    const int bytesPerRow = width * 4;
    if (!pitch) pitch = bytesPerRow;
    if (pitch > 0 && pitch != bytesPerRow) {
        PixelStorei(kUnpackRowLength, pitch / 4);
        TexImage2D(width, height, pixels);
        PixelStorei(kUnpackRowLength, 0);
    } else {
        TexImage2D(width, height, pixels);
    }
    // IsOpaque is determined by uploaded contents: skip later alpha processing only if
    // every alpha value in the image is 255.
    bool opaque = true;
    for (int y = 0; y < height && opaque; ++y) {
        const uint8_t *row = static_cast<const uint8_t *>(pixels) + static_cast<size_t>(y) * pitch;
        for (int x = 0; x < width; ++x) {
            if (row[x * 4 + 3] != 255) { opaque = false; break; }
        }
    }
    texture->SetOpaque(opaque);
    return texture;
}

void Texture::Release() {
    if (--references_ <= 0) delete this;
}

Texture *Texture::Clone() const {
    Texture *copy = Create(width_, height_, renderTarget_);
    if (!copy) return nullptr;
    copy->SetOpaque(opaque_);
    // The source and target are separate textures; use an offscreen blit without involving the CPU.
    Device::Get().Copy(copy, const_cast<Texture *>(this), Rect(0, 0, width_, height_), 0, 0,
                       nullptr, Filter::Nearest);
    return copy;
}

Texture *Texture::EnsureWritable() {
    if (IsIndependent()) return this;
    Texture *copy = Clone();
    if (!copy) return nullptr;
    Release();
    return copy;
}

void Texture::Update(const void *pixels, int pitch, const Rect &rect) {
    if (!pixels || rect.Empty()) return;
    InvalidatePointCache();
    BindTexture(kTexture2D, name_);
    State().texture = name_;
    const int bytesPerRow = rect.Width() * 4;
    if (!pitch) pitch = bytesPerRow;
    if (pitch > 0 && pitch != bytesPerRow) {
        PixelStorei(kUnpackRowLength, pitch / 4);
        TexSubImage2D(rect.left, rect.top, rect.Width(), rect.Height(), pixels);
        PixelStorei(kUnpackRowLength, 0);
    } else {
        TexSubImage2D(rect.left, rect.top, rect.Width(), rect.Height(), pixels);
    }
    if (opaque_) {
        // A partial write may introduce translucent pixels; invalidate only if alpha < 255 occurs.
        bool opaque = true;
        for (int y = 0; y < rect.Height() && opaque; ++y) {
            const uint8_t *row = static_cast<const uint8_t *>(pixels) + static_cast<size_t>(y) * pitch;
            for (int x = 0; x < rect.Width(); ++x) {
                if (row[x * 4 + 3] != 255) { opaque = false; break; }
            }
        }
        if (!opaque) opaque_ = false;
    }
}

void Texture::ReadAll(void *out) const {
    Target source(const_cast<Texture *>(this));
    if (!source.Bind()) return;
    ReadPixels(0, 0, width_, height_, out);
}

namespace {
// More consecutive point queries within one generation indicate a pixel scan, so switch
// to a full-image snapshot. Fewer queries suggest one or two points per frame, where a 1x1
// readback is cheaper (a full 1080p image transfers 8 MB).
constexpr int kPointScanThreshold = 4;

inline uint32_t PackPixel(const uint8_t *pixel) {
    return (static_cast<uint32_t>(pixel[3]) << 24) | (static_cast<uint32_t>(pixel[0]) << 16) |
           (static_cast<uint32_t>(pixel[1]) << 8) | pixel[2];
}
} // namespace

uint32_t Texture::Point(int x, int y) const {
    if (x < 0 || y < 0 || x >= width_ || y >= height_) return 0;
    if (pointCacheValid_) {
        return PackPixel(pointCache_.data() + (static_cast<size_t>(y) * width_ + x) * 4);
    }
    const size_t size = static_cast<size_t>(width_) * height_ * 4;
    // For a few point queries, read only that pixel. readPixels is an implicit sync point,
    // but transferring 4 bytes is much cheaper than the full image. This is the normal path
    // for one or two queries per frame.
    if (++pointProbes_ < kPointScanThreshold) {
        uint8_t pixel[4] = {0, 0, 0, 0};
        Target source(const_cast<Texture *>(this));
        readingPoint_ = true;
        const bool bound = source.Bind();
        readingPoint_ = false;
        if (!bound) return 0;
        ReadPixels(x, y, 1, 1, pixel);
        return PackPixel(pixel);
    }
    // Many consecutive point queries indicate a full-image scan; read it back once and
    // query from memory.
    if (pointCache_.size() != size) pointCache_.resize(size);
    Target source(const_cast<Texture *>(this));
    readingPoint_ = true;
    const bool bound = source.Bind();
    if (!bound) {
        readingPoint_ = false;
        return 0;
    }
    ReadPixels(0, 0, width_, height_, pointCache_.data());
    readingPoint_ = false;
    pointCacheValid_ = true;
    return PackPixel(pointCache_.data() + (static_cast<size_t>(y) * width_ + x) * 4);
}

void Texture::SetPoint(int x, int y, uint32_t argb) {
    if (x < 0 || y < 0 || x >= width_ || y >= height_) return;
    const uint8_t pixel[4] = {
        static_cast<uint8_t>((argb >> 16) & 255), static_cast<uint8_t>((argb >> 8) & 255),
        static_cast<uint8_t>(argb & 255), static_cast<uint8_t>((argb >> 24) & 255)};
    Update(pixel, 4, Rect(x, y, x + 1, y + 1));
}

Target::Target(Texture *texture) : texture_(texture) {
    if (texture_) texture_->AddRef();
}

Target::~Target() {
    if (texture_) texture_->Release();
}

bool Target::Bind() {
    if (!texture_) return false;
    // Attaching as a render target means it is about to be drawn to, so immediately
    // invalidate Point's CPU snapshot.
    texture_->InvalidatePointCache();
    return Device::Get().SetRenderTarget(texture_);
}

} // namespace gal::render
