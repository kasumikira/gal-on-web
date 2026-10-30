#include "render/bitmap-surface.h"
#include <algorithm>
#include <functional>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace gal::render {

namespace {
using MeshVertex = BitmapSurface::MeshVertex;
using Coordinate = BitmapSurface::Coordinate;

std::vector<MeshVertex> ClipMesh(const std::vector<MeshVertex> &polygon,
                                 const std::function<double(const MeshVertex &)> &value,
                                 double edge, bool greater) {
    std::vector<MeshVertex> result;
    if (polygon.empty()) return result;
    auto inside = [&](const MeshVertex &v) { return greater ? value(v) >= edge : value(v) <= edge; };
    const MeshVertex *previous = &polygon.back();
    bool previousInside = inside(*previous);
    for (const auto &current : polygon) {
        const bool currentInside = inside(current);
        if (currentInside != previousInside) {
            const double a = value(*previous), b = value(current);
            const double t = (edge - a) / (b - a);
            MeshVertex intersection;
            intersection.x = previous->x + (current.x - previous->x) * t;
            intersection.y = previous->y + (current.y - previous->y) * t;
            const double q0 = 1.0 / previous->w, q1 = 1.0 / current.w;
            const double q = q0 + (q1 - q0) * t;
            intersection.w = 1.0 / q;
            intersection.texture.resize(previous->texture.size());
            for (size_t i = 0; i < intersection.texture.size(); ++i) {
                intersection.texture[i].x = (previous->texture[i].x * q0 + (current.texture[i].x * q1 - previous->texture[i].x * q0) * t) / q;
                intersection.texture[i].y = (previous->texture[i].y * q0 + (current.texture[i].y * q1 - previous->texture[i].y * q0) * t) / q;
            }
            result.push_back(std::move(intersection));
        }
        if (currentInside) result.push_back(current);
        previous = &current;
        previousInside = currentInside;
    }
    return result;
}

std::vector<MeshVertex> ClipMeshRect(std::vector<MeshVertex> polygon, const Rect &rect, size_t textureIndex) {
    polygon = ClipMesh(polygon, [=](const MeshVertex &v) { return v.texture[textureIndex].x; }, rect.left, true);
    polygon = ClipMesh(polygon, [=](const MeshVertex &v) { return v.texture[textureIndex].x; }, rect.right, false);
    polygon = ClipMesh(polygon, [=](const MeshVertex &v) { return v.texture[textureIndex].y; }, rect.top, true);
    polygon = ClipMesh(polygon, [=](const MeshVertex &v) { return v.texture[textureIndex].y; }, rect.bottom, false);
    return polygon;
}
}
namespace {
void RequireTexture(Texture *texture) {
    if (!texture) throw std::runtime_error("Cannot allocate bitmap texture");
}
void CheckDrawing() {
    if (!Device::Get().LastError().empty())
        throw std::runtime_error(Device::Get().LastError());
}
}

BitmapSurface::BitmapSurface(int width, int height) : width_(width), height_(height) {
    if (!Device::Get().Ready()) throw std::runtime_error("Bitmap requires an initialized renderer");
    if (width <= 0 || height <= 0) throw std::runtime_error("Invalid bitmap dimensions");
    const int limit = Device::Get().MaxTextureSize();
    if (limit <= 2) throw std::runtime_error("Insufficient texture size for bitmaps");
    const int extent = limit - 2;
    for (int y = 0; y < height;) {
        const int bottom = y + std::min(extent, height - y);
        for (int x = 0; x < width;) {
            const int right = x + std::min(extent, width - x);
            const Rect logical(x, y, right, bottom);
            const Rect storage(std::max(0, x - 1), std::max(0, y - 1),
                               right < width ? right + 1 : right,
                               bottom < height ? bottom + 1 : bottom);
            tiles_.push_back({logical, storage, nullptr});
            x = right;
        }
        y = bottom;
    }
}

std::unique_ptr<BitmapSurface> BitmapSurface::Create(int width, int height, uint32_t color) {
    auto image = std::unique_ptr<BitmapSurface>(new BitmapSurface(width, height));
    for (auto &tile : image->tiles_) {
        tile.texture.reset(Texture::Create(tile.storage.Width(), tile.storage.Height(), true));
        RequireTexture(tile.texture.get());
        Device::Get().Fill(tile.texture.get(), Rect(0, 0, tile.storage.Width(), tile.storage.Height()), color, nullptr);
        CheckDrawing();
    }
    return image;
}

std::unique_ptr<BitmapSurface> BitmapSurface::FromRGBA(const void *pixels, int width, int height, int pitch) {
    if (!pixels) throw std::runtime_error("Bitmap pixels are required");
    auto image = std::unique_ptr<BitmapSurface>(new BitmapSurface(width, height));
    if (!pitch) pitch = width * 4;
    if (pitch < width * 4 || pitch % 4) throw std::runtime_error("Invalid RGBA bitmap pitch");
    for (auto &tile : image->tiles_) {
        const auto *start = static_cast<const uint8_t *>(pixels) +
            static_cast<size_t>(tile.storage.top) * pitch + static_cast<size_t>(tile.storage.left) * 4;
        tile.texture.reset(Texture::FromRGBA(start, tile.storage.Width(), tile.storage.Height(), pitch));
        RequireTexture(tile.texture.get());
    }
    return image;
}

BitmapSurface::BitmapSurface(const BitmapSurface &source) : width_(source.width_), height_(source.height_) {
    tiles_.reserve(source.tiles_.size());
    for (const auto &tile : source.tiles_)
        tiles_.push_back({tile.logical, tile.storage, TextureOwner(tile.texture->Share())});
}

void BitmapSurface::Present(int width, int height) const {
    const Rect view(0, 0, width, height);
    for (const auto &tile : tiles_) {
        Rect area = tile.logical.Intersect(view);
        if (area.Empty()) continue;
        const Rect source(area.left - tile.storage.left, area.top - tile.storage.top,
                          area.right - tile.storage.left, area.bottom - tile.storage.top);
        Device::Get().Present(tile.texture.get(), source, area, width, height);
    }
}

void BitmapSurface::Writable(Tile &tile) {
    auto *texture = tile.texture->EnsureWritable();
    RequireTexture(texture);
    // EnsureWritable consumes the old reference when it returns a clone.
    tile.texture.release();
    tile.texture.reset(texture);
}

void BitmapSurface::Fill(const Rect &rect, uint32_t color) {
    for (auto &tile : tiles_) {
        const auto area = rect.Intersect(tile.storage);
        if (area.Empty()) continue;
        Writable(tile);
        Device::Get().Fill(tile.texture.get(), area.Offset(-tile.storage.left, -tile.storage.top), color, nullptr);
        CheckDrawing();
    }
}

void BitmapSurface::Draw(const BitmapSurface &source, const Rect &sourceRect,
                         const std::array<double, 6> &matrix, Blend blend, bool holdAlpha,
                         int opacity, const Rect &clip, Filter filter) {
    if (opacity <= 0) return;
    auto *method = Device::Get().GetMethod(blend, holdAlpha, opacity);
    if (!method) throw std::runtime_error(Device::Get().LastError());
    Draw(source, sourceRect, matrix, method, opacity, clip, filter);
}

void BitmapSurface::Draw(const BitmapSurface &source, const Rect &sourceRect,
                         const std::array<double, 6> &matrix, Method *method, int opacity,
                         const Rect &clip, Filter filter, const std::function<void()> &applyParameters,
                         const BitmapSurface *referenceTarget) {
    // Explicit methods own the meaning of opacity: FillMask(0), for example,
    // clears alpha rather than skipping the draw.
    if (sourceRect.Empty() || clip.Empty()) return;
    const auto region = sourceRect.Intersect(Rect(0, 0, source.width_, source.height_));
    if (region.Empty()) return;
    // Self-copy must sample the pre-write image, including other tiles.
    std::unique_ptr<BitmapSurface> snapshot;
    if (&source == this) snapshot = std::make_unique<BitmapSurface>(source);
    const auto &input = snapshot ? *snapshot : source;
    for (const auto &from : input.tiles_) {
        const auto part = region.Intersect(from.logical);
        if (part.Empty()) continue;
        const double sx[] = {double(part.left), double(part.right), double(part.left), double(part.right)};
        const double sy[] = {double(part.top), double(part.top), double(part.bottom), double(part.bottom)};
        double px[4], py[4];
        for (int i = 0; i < 4; ++i) {
            px[i] = matrix[0] * sx[i] + matrix[2] * sy[i] + matrix[4];
            py[i] = matrix[1] * sx[i] + matrix[3] * sy[i] + matrix[5];
        }
        for (size_t tileIndex = 0; tileIndex < tiles_.size(); ++tileIndex) {
            auto &to = tiles_[tileIndex];
            const auto area = clip.Intersect(to.storage);
            if (area.Empty()) continue;
            // Compare in doubles before converting local coordinates to float.
            if (*std::max_element(px, px + 4) <= area.left || *std::min_element(px, px + 4) >= area.right ||
                *std::max_element(py, py + 4) <= area.top || *std::min_element(py, py + 4) >= area.bottom) continue;
            Writable(to);
            float quad[8];
            for (int i = 0; i < 4; ++i) {
                quad[i * 2] = static_cast<float>(px[i] - to.storage.left);
                quad[i * 2 + 1] = static_cast<float>(py[i] - to.storage.top);
            }
            const auto localClip = area.Offset(-to.storage.left, -to.storage.top);
            Device::Get().DrawQuad(to.texture.get(), from.texture.get(),
                part.Offset(-from.storage.left, -from.storage.top), quad,
                method, opacity, &localClip, filter, applyParameters,
                referenceTarget ? referenceTarget->tiles_[tileIndex].texture.get() : nullptr);
            CheckDrawing();
        }
    }
}

void BitmapSurface::DrawTwo(const BitmapSurface &first, const Rect &firstRect,
                            const BitmapSurface &second, const Rect &secondRect,
                            const Rect &destination, Method *method, int opacity,
                            const std::function<void()> &applyParameters) {
    // Original transition handlers supply two equal-sized, unscaled rectangles.
    if (firstRect.Width() != destination.Width() || firstRect.Height() != destination.Height() ||
        secondRect.Width() != destination.Width() || secondRect.Height() != destination.Height())
        throw std::runtime_error("Transition source rectangles must match the destination size");
    // Preserve pre-write sources when the transition renders into either input.
    std::unique_ptr<BitmapSurface> firstSnapshot, secondSnapshot;
    if (&first == this) firstSnapshot = std::make_unique<BitmapSurface>(first);
    if (&second == this) secondSnapshot = std::make_unique<BitmapSurface>(second);
    const auto &a = firstSnapshot ? *firstSnapshot : first;
    const auto &b = secondSnapshot ? *secondSnapshot : second;
    const int ax = destination.left - firstRect.left, ay = destination.top - firstRect.top;
    const int bx = destination.left - secondRect.left, by = destination.top - secondRect.top;
    for (const auto &fromA : a.tiles_) {
        const auto regionA = fromA.logical.Intersect(firstRect).Offset(ax, ay);
        if (regionA.Empty()) continue;
        for (const auto &fromB : b.tiles_) {
            const auto region = regionA.Intersect(fromB.logical.Intersect(secondRect).Offset(bx, by));
            if (region.Empty()) continue;
            for (auto &to : tiles_) {
                const auto area = region.Intersect(to.storage);
                if (area.Empty()) continue;
                Writable(to);
                const auto local = area.Offset(-to.storage.left, -to.storage.top);
                const float quad[] = {float(local.left), float(local.top), float(local.right), float(local.top),
                                      float(local.left), float(local.bottom), float(local.right), float(local.bottom)};
                const auto sourceA = area.Offset(-ax - fromA.storage.left, -ay - fromA.storage.top);
                const auto sourceB = area.Offset(-bx - fromB.storage.left, -by - fromB.storage.top);
                Device::Get().DrawQuad(to.texture.get(), fromA.texture.get(), sourceA, quad,
                    // Phase zero still writes source one. The method callback sets
                    // the transition's opacity uniform; draw opacity is not coverage.
                    method, 255, &local, Filter::Nearest, applyParameters, nullptr,
                    fromB.texture.get(), &sourceB);
                CheckDrawing();
            }
        }
    }
}

void BitmapSurface::DrawMesh(const std::vector<const BitmapSurface *> &sources,
                             const std::vector<MeshVertex> &vertices, const Rect &clip,
                             Method *method, int opacity, Filter filter,
                             const std::function<void()> &applyParameters,
                             const BitmapSurface *referenceTarget) {
    if (!method || vertices.empty() || vertices.size() % 3 || clip.Empty()) return;
    std::vector<std::unique_ptr<BitmapSurface>> snapshots(sources.size());
    std::vector<const BitmapSurface *> inputs = sources;
    for (size_t i = 0; i < inputs.size(); ++i) {
        if (inputs[i] == this) {
            snapshots[i] = std::make_unique<BitmapSurface>(*this);
            inputs[i] = snapshots[i].get();
        }
    }
    std::unique_ptr<BitmapSurface> targetSnapshot;
    if (method->targetAsInput) {
        if (referenceTarget && referenceTarget != this) inputs.push_back(referenceTarget);
        else {
            targetSnapshot = std::make_unique<BitmapSurface>(*this);
            inputs.push_back(targetSnapshot.get());
        }
    }
    if (inputs.size() != static_cast<size_t>(method->textureCount))
        throw std::runtime_error("Render method source count does not match mesh textures");
    for (const auto *input : inputs)
        if (!input) throw std::runtime_error("Render mesh has a null texture");

    for (auto &targetTile : tiles_) {
        const Rect targetArea = clip.Intersect(targetTile.storage);
        if (targetArea.Empty()) continue;
        std::vector<std::vector<MeshVertex>> triangles;
        for (size_t i = 0; i < vertices.size(); i += 3)
            triangles.push_back({vertices[i], vertices[i + 1], vertices[i + 2]});
        std::vector<Texture *> bound(inputs.size());
        std::function<void(size_t, std::vector<MeshVertex>)> drawSourceTiles;
        drawSourceTiles = [&](size_t sourceIndex, std::vector<MeshVertex> polygon) {
            if (polygon.size() < 3) return;
            if (sourceIndex == inputs.size()) {
                polygon = ClipMesh(polygon, [](const MeshVertex &v) { return v.x; }, targetArea.left, true);
                polygon = ClipMesh(polygon, [](const MeshVertex &v) { return v.x; }, targetArea.right, false);
                polygon = ClipMesh(polygon, [](const MeshVertex &v) { return v.y; }, targetArea.top, true);
                polygon = ClipMesh(polygon, [](const MeshVertex &v) { return v.y; }, targetArea.bottom, false);
                if (polygon.size() < 3) return;
                Writable(targetTile);
                std::vector<float> packed;
                const size_t positionFloats = method->perspective ? 3 : 2;
                packed.reserve((polygon.size() - 2) * 3 * (positionFloats + 2 * inputs.size()));
                for (size_t i = 1; i + 1 < polygon.size(); ++i) {
                    const MeshVertex *tri[] = {&polygon[0], &polygon[i], &polygon[i + 1]};
                    for (const auto *v : tri) {
                        packed.push_back(static_cast<float>(v->x - targetTile.storage.left));
                        packed.push_back(static_cast<float>(v->y - targetTile.storage.top));
                        if (method->perspective) packed.push_back(static_cast<float>(v->w));
                        for (size_t u = 0; u < inputs.size(); ++u) {
                            packed.push_back(static_cast<float>(v->texture[u].x));
                            packed.push_back(static_cast<float>(v->texture[u].y));
                        }
                    }
                }
                std::vector<Texture *> selected;
                selected.reserve(bound.size());
                for (auto *texture : bound) selected.push_back(texture);
                const Rect localClip = targetArea.Offset(-targetTile.storage.left, -targetTile.storage.top);
                Device::Get().DrawTriangles(targetTile.texture.get(), selected, packed,
                    static_cast<int>(packed.size() / (positionFloats + 2 * inputs.size())), method,
                    opacity, &localClip,
                    filter, applyParameters);
                CheckDrawing();
                return;
            }
            const BitmapSurface &input = *inputs[sourceIndex];
            for (const auto &sourceTile : input.tiles_) {
                auto clipped = ClipMeshRect(polygon, sourceTile.logical, sourceIndex);
                if (clipped.size() < 3) continue;
                bound[sourceIndex] = sourceTile.texture.get();
                for (auto &v : clipped) {
                    v.texture[sourceIndex].x = (v.texture[sourceIndex].x - sourceTile.storage.left) / sourceTile.texture->Width();
                    v.texture[sourceIndex].y = (v.texture[sourceIndex].y - sourceTile.storage.top) / sourceTile.texture->Height();
                }
                // Undo UV normalization for the next source-boundary clip is not
                // needed: each source has its own independent coordinate pair.
                drawSourceTiles(sourceIndex + 1, std::move(clipped));
            }
        };
        for (auto &triangle : triangles) {
            for (auto &vertex : triangle) {
                if (vertex.texture.size() != sources.size())
                    throw std::runtime_error("Mesh vertex texture coordinate count mismatch");
                if (method->targetAsInput) vertex.texture.push_back({vertex.x, vertex.y});
            }
            drawSourceTiles(0, std::move(triangle));
        }
    }
}

uint32_t BitmapSurface::Point(int x, int y) const {
    if (x < 0 || y < 0 || x >= width_ || y >= height_)
        throw std::runtime_error("Bitmap point is outside the image");
    for (const auto &tile : tiles_) {
        if (x >= tile.logical.left && x < tile.logical.right &&
            y >= tile.logical.top && y < tile.logical.bottom)
            return tile.texture->Point(x - tile.storage.left, y - tile.storage.top);
    }
    throw std::runtime_error("Bitmap point has no texture tile");
}

void BitmapSurface::Update(const void *pixels, int pitch, const Rect &rect) {
    if (rect.Empty()) return;
    if (!pixels || pitch < rect.Width() * 4 || pitch % 4)
        throw std::runtime_error("Invalid bitmap update pixels or pitch");
    for (auto &tile : tiles_) {
        const auto area = rect.Intersect(tile.storage);
        if (area.Empty()) continue;
        const auto *start = static_cast<const uint8_t *>(pixels) +
            size_t(area.top - rect.top) * pitch + size_t(area.left - rect.left) * 4;
        Writable(tile);
        tile.texture->Update(start, pitch, area.Offset(-tile.storage.left, -tile.storage.top));
        CheckDrawing();
    }
}

void BitmapSurface::Copy(const BitmapSurface &source, const Rect &sourceRect, int x, int y) {
    // iTVPBaseBitmap::CopyRect shares an entire image instead of rendering it.
    if (x == 0 && y == 0 && width_ == source.width_ && height_ == source.height_ &&
        sourceRect == Rect(0, 0, source.width_, source.height_)) {
        if (&source != this) {
            BitmapSurface shared(source);
            tiles_.swap(shared.tiles_);
        }
        return;
    }
    Draw(source, sourceRect, {1, 0, 0, 1, double(x) - sourceRect.left, double(y) - sourceRect.top},
         Blend::Copy, false, 255, Rect(0, 0, width_, height_), Filter::Nearest);
}

void BitmapSurface::SetSize(int width, int height, bool keepImage, uint32_t fill) {
    if (width < 0 || height < 0) throw std::runtime_error("Invalid bitmap dimensions");
    // tTVPNativeBaseBitmap::SetSize normalizes a zero extent to one pixel,
    // and does nothing for unchanged dimensions, even when keepImage is false.
    width = std::max(1, width);
    height = std::max(1, height);
    if (width == width_ && height == height_) return;
    auto replacement = Create(width, height, fill);
    if (keepImage)
        replacement->Copy(*this, Rect(0, 0, std::min(width, width_), std::min(height, height_)), 0, 0);
    tiles_.swap(replacement->tiles_);
    width_ = width;
    height_ = height;
}

void BitmapSurface::ReadRGBA(void *out, int pitch) const {
    if (!out) throw std::runtime_error("Bitmap output is required");
    if (!pitch) pitch = width_ * 4;
    if (pitch < width_ * 4) throw std::runtime_error("Invalid bitmap output pitch");
    std::vector<uint8_t> pixels;
    for (const auto &tile : tiles_) {
        pixels.resize(static_cast<size_t>(tile.storage.Width()) * tile.storage.Height() * 4);
        tile.texture->ReadAll(pixels.data());
        CheckDrawing();
        for (int y = tile.logical.top; y < tile.logical.bottom; ++y) {
            const auto offset = (static_cast<size_t>(y - tile.storage.top) * tile.storage.Width() +
                                 tile.logical.left - tile.storage.left) * 4;
            std::memcpy(static_cast<uint8_t *>(out) + static_cast<size_t>(y) * pitch +
                        static_cast<size_t>(tile.logical.left) * 4,
                        pixels.data() + offset, static_cast<size_t>(tile.logical.Width()) * 4);
        }
    }
}

} // namespace gal::render
