#include "NativeRenderManager.h"
#include "NativeTexture.h"
#include "LayerBitmapIntf.h"
#include "tvpgl.h"
#include "Platform.h"
#include "tjsHashSearch.h"
#include <algorithm>
#include <cstring>
#include <array>
#include <cmath>
#include <stdexcept>

using namespace gal::render;
using namespace gal::gles;
namespace {
Rect RectOf(const tTVPRect &r) { return {r.left, r.top, r.right, r.bottom}; }
tTVPGLESTexture &TextureOf(iTVPTexture2D *texture) { return *static_cast<tTVPGLESTexture *>(texture); }

std::array<double, 8> Homography(const std::array<gal::render::BitmapSurface::Coordinate, 4> &dst,
                                const std::array<gal::render::BitmapSurface::Coordinate, 4> &src) {
    double a[8][9]{};
    for (int i = 0; i < 4; ++i) {
        const double x = dst[i].x, y = dst[i].y, u = src[i].x, v = src[i].y;
        a[i * 2][0] = x; a[i * 2][1] = y; a[i * 2][2] = 1;
        a[i * 2][6] = -u * x; a[i * 2][7] = -u * y; a[i * 2][8] = u;
        a[i * 2 + 1][3] = x; a[i * 2 + 1][4] = y; a[i * 2 + 1][5] = 1;
        a[i * 2 + 1][6] = -v * x; a[i * 2 + 1][7] = -v * y; a[i * 2 + 1][8] = v;
    }
    for (int col = 0; col < 8; ++col) {
        int pivot = col;
        for (int row = col + 1; row < 8; ++row)
            if (std::abs(a[row][col]) > std::abs(a[pivot][col])) pivot = row;
        if (std::abs(a[pivot][col]) < 1e-12) throw std::runtime_error("Perspective quad is degenerate");
        if (pivot != col) for (int j = col; j < 9; ++j) std::swap(a[pivot][j], a[col][j]);
        const double scale = a[col][col];
        for (int j = col; j < 9; ++j) a[col][j] /= scale;
        for (int row = 0; row < 8; ++row) {
            if (row == col) continue;
            const double factor = a[row][col];
            for (int j = col; j < 9; ++j) a[row][j] -= factor * a[col][j];
        }
    }
    std::array<double, 8> h{};
    for (int i = 0; i < 8; ++i) h[i] = a[i][8];
    return h;
}
}

Method *tTVPGLESRenderMethod::Program() { return TVPGetVisualRenderMethod(Name.c_str()); }
iTVPRenderMethod *tTVPGLESRenderMethod::SetBlendFuncSeparate(int func, int srcRGB, int dstRGB, int srcAlpha, int dstAlpha) {
    auto *program = Program();
    program->blend = true;
    program->equationRGB = program->equationA = func;
    program->srcRGB = srcRGB; program->dstRGB = dstRGB;
    program->srcA = srcAlpha; program->dstA = dstAlpha;
    return this;
}
bool tTVPGLESRenderMethod::IsBlendTarget() { return Program()->blend; }
int tTVPGLESRenderMethod::EnumParameterID(const char *name) {
    if (BoxBlur) {
        if (!std::strcmp(name, "area_left")) return AreaLeft;
        if (!std::strcmp(name, "area_top")) return AreaTop;
        if (!std::strcmp(name, "area_right")) return AreaRight;
        if (!std::strcmp(name, "area_bottom")) return AreaBottom;
    }
    for (size_t i = 0; i < Parameters.size(); ++i)
        if (Parameters[i].Name == name) return int(i);
    Parameter parameter;
    parameter.Name = name;
    Parameters.push_back(std::move(parameter));
    return int(Parameters.size() - 1);
}
void tTVPGLESRenderMethod::SetParameterOpa(int id, int value) {
    Opacity = value;
    SetParameterFloat(id, value / 255.f);
}
void tTVPGLESRenderMethod::SetParameterColor4B(int id, unsigned value) {
    Color = value;
    float color[] = {float(value & 255) / 255, float((value >> 8) & 255) / 255,
                     float((value >> 16) & 255) / 255, float(value >> 24) / 255};
    SetParameterFloatArray(id, color, 4);
}
void tTVPGLESRenderMethod::SetParameterFloat(int id, float value) { SetParameterFloatArray(id, &value, 1); }
void tTVPGLESRenderMethod::SetParameterInt(int id, int value) {
    if (id < 0) return;
    if (BoxBlur && id >= AreaLeft && id <= AreaBottom) {
        switch (id) {
            case AreaLeft: BlurLeft = value; break;
            case AreaTop: BlurTop = value; break;
            case AreaRight: BlurRight = value; break;
            case AreaBottom: BlurBottom = value; break;
        }
        return;
    }
    auto &parameter = Parameters.at(id);
    if (Name.rfind("UnivTransBlend", 0) == 0 &&
        (parameter.Name == "phase" || parameter.Name == "vague")) {
        if (parameter.Name == "vague") TransitionVague = value;
        parameter.Integer = false;
        parameter.Values.assign(1, (parameter.Name == "phase" ? value - TransitionVague : value) / 255.f);
        return;
    }
    parameter.Integer = true; parameter.IntegerValue = value;
}
void tTVPGLESRenderMethod::SetParameterUInt(int id, unsigned value) { SetParameterInt(id, int(value)); }
void tTVPGLESRenderMethod::SetParameterPtr(int id, const void *value) {
    if ((Name == "AdjustGamma" || Name == "AdjustGamma_a") && Parameters.at(id).Name == "gammaAdjustData") {
        const auto &data = *static_cast<const tTVPGLGammaAdjustData *>(value);
        float gamma[] = {1.f / data.RGamma, 1.f / data.GGamma, 1.f / data.BGamma, 0};
        float floor[] = {data.RFloor / 255.f, data.GFloor / 255.f, data.BFloor / 255.f, 0};
        float amplitude[] = {(data.RCeil - data.RFloor) / 255.f,
                             (data.GCeil - data.GFloor) / 255.f,
                             (data.BCeil - data.BFloor) / 255.f, 0};
        SetParameterFloatArray(EnumParameterID("u_gamma"), gamma, 4);
        SetParameterFloatArray(EnumParameterID("u_floor"), floor, 4);
        SetParameterFloatArray(EnumParameterID("u_amp"), amplitude, 4);
        return;
    }
    TVPThrowExceptionMessage(TJS_W("Native render pointer parameter is not implemented: %1"), ttstr(Name));
}
void tTVPGLESRenderMethod::SetParameterFloatArray(int id, float *value, int count) {
    if (id < 0) return;
    auto &parameter = Parameters.at(id);
    parameter.Integer = false;
    parameter.Values.assign(value, value + count);
}
void tTVPGLESRenderMethod::ApplyBoxBlur(const iTVPTexture2D &source) {
    auto *method = Program();
    if (BlurSampleLocation == -2)
        BlurSampleLocation = GetUniformLocation(method->program, "u_sample");
    if (BlurSampleLocation < 0) return;
    float w = static_cast<float>(source.GetWidth());
    float h = static_cast<float>(source.GetHeight());
    if (w < 1.f) w = 1.f;
    if (h < 1.f) h = 1.f;
    // Reference tTVPOGLRenderMethod_BoxBlur::ApplyTexture: offsets are in
    // normalized texture coordinates and describe the 3x3 neighbourhood
    // around the current pixel (u_sample + the tex0 sample itself).
    const float l = BlurLeft / w, t = BlurTop / h;
    const float r = BlurRight / w, b = BlurBottom / h;
    const float samples[16] = {
        l, t, 0.f, t, r, t, l, 0.f,
        r, 0.f, l, b, 0.f, b, r, b,
    };
    Uniform2fv(BlurSampleLocation, 16, samples);
}
void tTVPGLESRenderMethod::Apply() {
    auto *method = Program();
    for (auto &parameter : Parameters) {
        if (parameter.Program != method->program) {
            const auto &name = parameter.Name == "color" ? "u_color" : parameter.Name;
            parameter.Location = GetUniformLocation(method->program, name);
            parameter.Program = method->program;
        }
        if (parameter.Location < 0) continue;
        const auto *v = parameter.Values.data();
        if (parameter.Integer) Uniform1i(parameter.Location, parameter.IntegerValue);
        else switch (parameter.Values.size()) {
            case 0: break;
            case 1: Uniform1f(parameter.Location, v[0]); break;
            case 2: Uniform2f(parameter.Location, v[0], v[1]); break;
            case 4: Uniform4f(parameter.Location, v[0], v[1], v[2], v[3]); break;
            default: Uniform1fv(parameter.Location, parameter.Values.size(), v); break;
        }
    }
}

iTVPTexture2D *tTVPGLESRenderManager::CreateTexture2D(const void *pixels, int pitch, unsigned width,
                                                    unsigned height, TVPTextureFormat::e format, int) {
    auto texture = std::make_unique<tTVPGLESTexture>(width, height, format);
    if (pixels) texture->Update(pixels, format, pitch, {0, 0, int(width), int(height)});
    return texture.release();
}
iTVPTexture2D *tTVPGLESRenderManager::CreateTexture2D(tTVPBitmap *bitmap) {
    return CreateTexture2D(bitmap->GetBits(), bitmap->GetPitch(), bitmap->GetWidth(), bitmap->GetHeight(),
                           bitmap->Is8bit() ? TVPTextureFormat::Gray : TVPTextureFormat::RGBA, 0);
}
iTVPTexture2D *tTVPGLESRenderManager::CreateTexture2D(unsigned width, unsigned height, iTVPTexture2D *source) {
    if (source->GetWidth() == width && source->GetHeight() == height)
        return new tTVPGLESTexture(TextureOf(source));
    auto texture = std::make_unique<tTVPGLESTexture>(width, height, source->GetFormat());
    texture->GetSurface().Copy(TextureOf(source).GetSurface(),
        {0, 0, int(std::min(width, source->GetWidth())), int(std::min(height, source->GetHeight()))}, 0, 0);
    texture->DidRender();
    return texture.release();
}
iTVPRenderMethod *tTVPGLESRenderManager::GetRenderMethod(const char *name, uint32_t *) {
    auto &method = Methods[name];
    if (!method) method = std::make_unique<tTVPGLESRenderMethod>(name);
    method->Program();
    return method.get();
}
void iTVPRenderManager::RegisterRenderMethod(const char *name, iTVPRenderMethod *method) {
    method->SetName(name);
    AllMethods[tTJSHashFunc<tjs_nchar *>::Make(name)] = method;
}
iTVPRenderMethod *iTVPRenderManager::GetRenderMethod(const char *name, uint32_t *hint) {
    const uint32_t hash = hint && *hint ? *hint : tTJSHashFunc<tjs_nchar *>::Make(name);
    if (hint) *hint = hash;
    const auto found = AllMethods.find(hash);
    if (found == AllMethods.end()) TVPThrowExceptionMessage(TJS_W("Unknown render method: %1"), ttstr(name));
    return found->second;
}
iTVPRenderMethod *iTVPRenderManager::GetOrCompileRenderMethod(const char *name, uint32_t *, const char *script, int nTex, unsigned int flags) {
    auto &device = Device::Get();
    if (!device.FindMethod(name)) {
        std::string source(script);
        const auto main = source.find("void main() {");
        const auto end = source.rfind('}');
        if (main == std::string::npos || end == std::string::npos || end < main)
            TVPThrowExceptionMessage(TJS_W("Unsupported render shader"));
        std::string declarations = source.substr(0, main);
        std::string body = source.substr(main + 13, end - main - 13);
        const auto replace = [&](const std::string &from, const std::string &to) {
            size_t pos = 0;
            while ((pos = body.find(from, pos)) != std::string::npos) {
                body.replace(pos, from.size(), to); pos += to.size();
            }
        };
        replace("gl_FragColor", "fragColor");
        replace("texture2D", "texture");
        for (int i = 0; i < nTex; ++i)
            replace("v_texCoord" + std::to_string(i), i ? "v_uv" + std::to_string(i) : "v_uv");
        if (!device.CompileMethod(name, body, (flags & RENDER_METHOD_FLAG_TARGET_AS_INPUT) != 0, declarations, nTex))
            TVPThrowExceptionMessage(ttstr(device.LastError()).c_str());
    }
    return GetRenderMethod(name);
}
iTVPRenderMethod *iTVPRenderManager::GetRenderMethod(tjs_int opacity, bool holdAlpha, int blend) {
    auto *method = Device::Get().GetMethod(static_cast<Blend>(blend), holdAlpha, opacity);
    if (!method) return nullptr;
    auto *result = GetRenderMethod(method->name.c_str());
    result->SetParameterOpa(result->EnumParameterID("opacity"), opacity);
    return result;
}

void tTVPGLESRenderManager::OperateRect(iTVPRenderMethod *rawMethod, iTVPTexture2D *target,
                                       iTVPTexture2D *reference, const tTVPRect &destination,
                                       const tRenderTexRectArray &textures) {
    if (destination.is_empty()) return;
    auto &method = *static_cast<tTVPGLESRenderMethod *>(rawMethod);
    auto &output = TextureOf(target);
    if (output.GetFormat() == TVPTextureFormat::Gray && method.GetName() == "FillARGB") {
        tTVPRect area = destination;
        if (!area.clip({0, 0, int(output.GetWidth()), int(output.GetHeight())})) return;
        for (int y = area.top; y < area.bottom; ++y)
            std::memset(static_cast<uint8_t *>(output.GetScanLineForWrite(y)) + area.left,
                        method.Color & 255, area.get_width());
        return;
    }
    auto &surface = output.GetSurface();
    // BoxBlur needs one extra uniform that depends on the submitted source
    // texture; every other method only uploads its named parameters.
    const auto applyParameters = [&] {
        method.Apply();
        if (method.IsBoxBlur() && textures.size() == 1)
            method.ApplyBoxBlur(*textures[0].first);
    };
    if (method.GetName() == "FillARGB") {
        const uint32_t color = method.Color;
        surface.Fill(RectOf(destination), (color & 0xff00ff00) | ((color & 255) << 16) | ((color >> 16) & 255));
    } else {
        if (textures.size() >= 2) {
            std::vector<const BitmapSurface *> sources;
            sources.reserve(textures.size());
            for (size_t textureIndex = 0; textureIndex < textures.size(); ++textureIndex)
                sources.push_back(&TextureOf(textures[textureIndex].first).GetSurface());
            std::vector<BitmapSurface::MeshVertex> vertices(6);
            const auto &rect = destination;
            const double x[4] = {double(rect.left), double(rect.right), double(rect.left), double(rect.right)};
            const double y[4] = {double(rect.top), double(rect.top), double(rect.bottom), double(rect.bottom)};
            const int order[6] = {0, 1, 2, 2, 1, 3};
            for (int i = 0; i < 6; ++i) {
                auto &vertex = vertices[i];
                const int corner = order[i];
                vertex.x = x[corner]; vertex.y = y[corner];
                vertex.texture.reserve(textures.size());
                for (size_t textureIndex = 0; textureIndex < textures.size(); ++textureIndex) {
                    const auto &texture = textures[textureIndex];
                    const auto &r = texture.second;
                    vertex.texture.push_back({
                        corner == 0 || corner == 2 ? double(r.left) : double(r.right),
                        corner == 0 || corner == 1 ? double(r.top) : double(r.bottom)});
                }
            }
            surface.DrawMesh(sources, vertices, RectOf(destination), method.Program(), method.Opacity,
                             Filter::Linear, applyParameters,
                             reference && reference != target ? &TextureOf(reference).GetSurface() : nullptr);
            output.DidRender();
            return;
        }
        std::unique_ptr<BitmapSurface> solid;
        BitmapSurface *input;
        Rect source;
        if (textures.size()) {
            input = &TextureOf(textures[0].first).GetSurface();
            source = RectOf(textures[0].second);
        } else {
            solid = BitmapSurface::Create(1, 1, 0xffffffff);
            input = solid.get(); source = {0, 0, 1, 1};
        }
        if (source.Empty()) return;
        const double x = double(destination.get_width()) / source.Width();
        const double y = double(destination.get_height()) / source.Height();
        surface.Draw(*input, source, {x, 0, 0, y, destination.left - x * source.left, destination.top - y * source.top},
            method.Program(), method.Opacity, RectOf(destination), Filter::Linear, applyParameters,
            reference && reference != target ? &TextureOf(reference).GetSurface() : nullptr);
    }
    output.DidRender();
}

void tTVPGLESRenderManager::OperateTriangles(iTVPRenderMethod *rawMethod, int triangles, iTVPTexture2D *target,
        iTVPTexture2D *reference, const tTVPRect &clip, const tTVPPointD *points, const tRenderTexQuadArray &textures) {
    if (triangles <= 0 || textures.size() == 0 || clip.is_empty()) return;
    const int vertexCount = triangles * 3;
    std::vector<const BitmapSurface *> sources;
    std::vector<BitmapSurface::MeshVertex> vertices(vertexCount);
    sources.reserve(textures.size());
    for (size_t textureIndex = 0; textureIndex < textures.size(); ++textureIndex) {
        sources.push_back(&TextureOf(textures[textureIndex].first).GetSurface());
        if (!textures[textureIndex].second)
            TVPThrowExceptionMessage(TJS_W("Triangle texture coordinates are null"));
        for (int vertexIndex = 0; vertexIndex < vertexCount; ++vertexIndex) {
            const auto &point = textures[textureIndex].second[vertexIndex];
            if (vertices[vertexIndex].texture.size() != textureIndex)
                TVPThrowExceptionMessage(TJS_W("Triangle texture arrays are inconsistent"));
            vertices[vertexIndex].texture.push_back({point.x, point.y});
        }
    }
    for (int i = 0; i < vertexCount; ++i) {
        vertices[i].x = points[i].x;
        vertices[i].y = points[i].y;
    }
    auto &method = *static_cast<tTVPGLESRenderMethod *>(rawMethod);
    auto &output = TextureOf(target);
    output.GetSurface().DrawMesh(sources, vertices, RectOf(clip), method.Program(), method.Opacity,
        Filter::Linear, [&] { method.Apply(); },
        reference && reference != target ? &TextureOf(reference).GetSurface() : nullptr);
    output.DidRender();
}
void tTVPGLESRenderManager::OperatePerspective(iTVPRenderMethod *rawMethod, int quads, iTVPTexture2D *target,
        iTVPTexture2D *reference, const tTVPRect &clip, const tTVPPointD *points,
        const tRenderTexQuadArray &textures) {
    if (quads <= 0 || textures.size() == 0 || clip.is_empty()) return;
    auto &method = *static_cast<tTVPGLESRenderMethod *>(rawMethod);
    if (!method.Program()->perspective || textures.size() != 1)
        TVPThrowExceptionMessage(TJS_W("Perspective rendering requires PerspectiveAlphaBlend_a and one source texture"));
    auto &destinationTexture = TextureOf(target);
    auto &sourceTexture = TextureOf(textures[0].first);
    const auto *source = textures[0].second;
    std::vector<BitmapSurface::MeshVertex> vertices;
    vertices.reserve(static_cast<size_t>(quads) * 6);
    for (int q = 0; q < quads; ++q) {
        const auto *dst = points + q * 4;
        const auto *src = source + q * 4;
        const int order[6] = {0, 1, 2, 2, 1, 3};
        const std::array<BitmapSurface::Coordinate, 4> dstOrdered = {{{dst[0].x,dst[0].y},{dst[1].x,dst[1].y},{dst[3].x,dst[3].y},{dst[2].x,dst[2].y}}};
        const std::array<BitmapSurface::Coordinate, 4> srcOrdered = {{{src[0].x,src[0].y},{src[1].x+1,src[1].y},{src[3].x+1,src[3].y+1},{src[2].x,src[2].y+1}}};
        const auto h = Homography(dstOrdered, srcOrdered);
        const BitmapSurface::Coordinate srcCorners[4] = {
            {src[0].x, src[0].y}, {src[1].x + 1, src[1].y},
            {src[2].x, src[2].y + 1}, {src[3].x + 1, src[3].y + 1}};
        for (int i = 0; i < 6; ++i) {
            const int corner = order[i];
            const auto &dstPoint = dst[corner];
            const double denom = h[6] * dstPoint.x + h[7] * dstPoint.y + 1;
            if (std::abs(denom) < 1e-12) TVPThrowExceptionMessage(TJS_W("Perspective mapping is singular"));
            BitmapSurface::MeshVertex vertex;
            vertex.x = dstPoint.x; vertex.y = dstPoint.y; vertex.w = 1.0 / denom;
            vertex.texture.push_back(srcCorners[corner]);
            vertices.push_back(std::move(vertex));
        }
    }
    const std::vector<const BitmapSurface *> sources = {&sourceTexture.GetSurface()};
    destinationTexture.GetSurface().DrawMesh(sources, vertices, RectOf(clip), method.Program(), method.Opacity,
        Filter::Linear, [&] { method.Apply(); },
        reference && reference != target ? &TextureOf(reference).GetSurface() : nullptr);
    destinationTexture.DidRender();
}
bool tTVPGLESRenderManager::GetRenderStat(unsigned &draws, uint64_t &memory) {
    draws = Device::Get().DrawCount(); memory = 0; return false;
}
void tTVPGLESRenderManager::BeginStencil(iTVPTexture2D *) {
    TVPThrowExceptionMessage(TJS_W("Motion stencil rendering is not implemented"));
}
void tTVPGLESRenderManager::SetRenderTarget(iTVPTexture2D *) {
    TVPThrowExceptionMessage(TJS_W("Motion manual render targets are not implemented"));
}

iTVPRenderManager *TVPGetRenderManager() { static tTVPGLESRenderManager manager; return &manager; }
iTVPRenderManager *TVPGetSoftwareRenderManager() { return TVPGetRenderManager(); }
bool TVPIsSoftwareRenderManager() { return false; }
