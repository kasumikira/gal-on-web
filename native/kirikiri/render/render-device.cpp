#include "render/render.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>

namespace gal::render {

using namespace gal::gles;

namespace {

std::string CoordName(int index) { return index == 0 ? "uv" : "uv" + std::to_string(index); }
std::string VaryingName(int index) { return index == 0 ? "v_uv" : "v_uv" + std::to_string(index); }
std::string SamplerName(int index) { return "tex" + std::to_string(index); }
const int kVertexFloats = 6;
const int kVertexStride = kVertexFloats * sizeof(float);

// Toggle completeness validation for the shared FBO. glCheckFramebufferStatus is a sync
// point: it must wait for the GPU command buffer to drain, interrupting CPU/GPU pipelining
// (about 0.6 ms per call in measurements, totaling 56 ms in the 152 ms interval when enabled).
// This project's FBO only attaches RGBA8 TEXTURE_2D images, has no depth/stencil attachment,
// and generates no mipmaps, so format constraints guarantee completeness without runtime
// validation. Enable this temporarily only when changing attachment combinations (adding
// depth, MRT, or a compressed format).
constexpr bool kValidateFramebuffer = false;

std::string VertexSource(int textureCount, bool perspective = false) {
    std::string source = R"(#version 300 es
uniform vec2 u_targetSize;
uniform float u_flipY;
)";
    source.insert(source.find("uniform vec2"), perspective ? "layout(location = 0) in vec3 a_position;\n" : "layout(location = 0) in vec2 a_position;\n");
    for (int i = 0; i < textureCount; ++i)
        source += "layout(location = " + std::to_string(i + 1) + ") in vec2 a_" + CoordName(i) + ";\nout vec2 " + VaryingName(i) + ";\n";
    source += "void main() {\n";
    for (int i = 0; i < textureCount; ++i)
        source += "    " + VaryingName(i) + " = a_" + CoordName(i) + ";\n";
    source += "    vec2 point = a_position.xy / u_targetSize * 2.0 - 1.0;\n";
    if (perspective)
        source += "    gl_Position = vec4(point.x * a_position.z, point.y * u_flipY * a_position.z, 0.0, a_position.z);\n}\n";
    else
        source += "    gl_Position = vec4(point.x, point.y * u_flipY, 0.0, 1.0);\n}\n";
    return source;
}

std::string FragmentSource(const std::string &body, const std::string &declarations = {}, int textureCount = 2) {
    // The reference declares mediump (required by mobile GLES). Under WebGL2, high precision
    // directly matches the software renderer's fixed-point results and avoids boundary flips
    // such as step(0.5, 128/255). Implementations without highp fall back to mediump.
    std::string source = R"(#version 300 es
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float opacity;
uniform vec4 u_color;
out vec4 fragColor;
)";
    for (int i = 0; i < textureCount; ++i)
        source += "uniform sampler2D " + SamplerName(i) + ";\nin vec2 " + VaryingName(i) + ";\n";
    source += declarations + "\nvoid main() {\n    vec4 s = texture(tex0, v_uv);\n" + body + "\n}\n";
    return source;
}

uint32_t CompileShaderStage(GLenum type, const std::string &source, std::string &error) {
    const GLuint shader = CreateShader(type);
    if (!shader) return 0;
    ShaderSource(shader, source);
    CompileShader(shader);
    if (!GetShaderParameter(shader, kCompileStatus)) {
        error = GetShaderInfoLog(shader);
        DeleteShader(shader);
        return 0;
    }
    return shader;
}

// Compile a program. On failure, store the driver log in error and let the caller decide whether to fall back.
uint32_t CompileProgram(const std::string &fragment, const std::string &label, std::string &error, int textureCount = 2, bool perspective = false) {
    const uint32_t vertex = CompileShaderStage(kVertexShader, VertexSource(textureCount, perspective), error);
    if (!vertex) { error = label + ": " + error; return 0; }
    const uint32_t pixel = CompileShaderStage(kFragmentShader, fragment, error);
    if (!pixel) { DeleteShader(vertex); error = label + ": " + error; return 0; }
    const GLuint program = CreateProgram();
    AttachShader(program, vertex);
    AttachShader(program, pixel);
    BindAttribLocation(program, 0, "a_position");
    for (int i = 0; i < textureCount; ++i)
        BindAttribLocation(program, i + 1, "a_" + CoordName(i));
    LinkProgram(program);
    DeleteShader(vertex);
    DeleteShader(pixel);
    if (!GetProgramParameter(program, kLinkStatus)) {
        error = label + ": " + GetProgramInfoLog(program);
        DeleteProgram(program);
        return 0;
    }
    return program;
}

struct MethodSpec {
    const char *name;
    const char *body;
    bool blend;
    GLenum equation;
    GLenum srcRGB, dstRGB, srcA, dstA;
    bool blendColor;
    bool targetAsInput;
};

// ScriptCommonBltPrefix from the reference: d when the target is used as input.
#define GAL_D "    vec4 d = texture(tex1, v_uv1);\n"

// Each fragment shader and blend state corresponds to a registration in the reference
// RenderManager_ogl.cpp. Names in comments are the reference registration names, making
// it easier to compare and complete them one by one.
// On platforms with framebuffer fetch, the reference changes the same shader to read
// gl_LastFragColor. WebGL2 lacks that extension, so this backend consistently uses a target
// snapshot and two textures while keeping the shader body unchanged.
const MethodSpec kMethods[] = {
    // ---------- Copy ----------
    {"Copy", "    fragColor = s;", false, kFuncAdd, kOne, kZero, kOne, kZero, false, false},
    {"CopyColor", "    fragColor = s;", true, kFuncAdd, kOne, kZero, kZero, kOne, false, false},
    {"CopyOpaqueImage", "    s.a = 1.0;\n    fragColor = s;", false, kFuncAdd, kOne, kZero, kOne, kZero, false, false},
    {"ConstAlphaBlend", "    fragColor = s;", true, kFuncAdd, kConstantColor, kOneMinusConstantColor,
     kZero, kOne, true, false},
    {"ConstAlphaBlend_a", "    s.a = opacity;\n    fragColor = s;", true, kFuncAdd, kOne,
     kOneMinusSrcAlpha, kOne, kOneMinusSrcAlpha, false, false},
    // ConstAlphaBlend_d: target alpha participates; treat the source as opaque.
    {"ConstAlphaBlend_d",
     GAL_D "    d.a = opacity + d.a - opacity * d.a;\n"
           "    d.rgb = mix(d.rgb, s.rgb, opacity / (d.a + 0.0001));\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},

    // ---------- AlphaBlend ----------
    {"AlphaBlend", "    s.a *= opacity;\n    fragColor = s;", true, kFuncAdd, kSrcAlpha,
     kOneMinusSrcAlpha, kZero, kOne, false, false},
    {"AlphaBlend_a", "    s.a *= opacity;\n    fragColor = s;", true, kFuncAdd, kSrcAlpha,
     kOneMinusSrcAlpha, kOne, kOneMinusSrcAlpha, false, false},
    {"AlphaBlend_d",
     GAL_D "    s.a *= opacity;\n"
           "    d.a = s.a + d.a - s.a * d.a;\n"
           "    d.rgb = mix(d.rgb, s.rgb, s.a / (d.a + 0.0001));\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},

    // ---------- AdditiveAlphaBlend ----------
    {"AdditiveAlphaBlend", "    fragColor = s * opacity;", true, kFuncAdd, kOne,
     kOneMinusSrcAlpha, kZero, kOne, false, false},
    {"AdditiveAlphaBlend_a", "    fragColor = s * opacity;", true, kFuncAdd, kOne,
     kOneMinusSrcAlpha, kOne, kOneMinusSrcAlpha, false, false},

    // ---------- Sub / Mul / Add ----------
    {"SubBlend", "    s.rgb = (1.0 - s.rgb) * opacity;\n    fragColor = s;", true,
     kFuncReverseSubtract, kOne, kOne, kZero, kOne, false, false},
    {"MulBlend", "    s.rgb = (1.0 - s.rgb) * opacity;\n    s.a = 0.0;\n    fragColor = s;", true,
     kFuncAdd, kZero, kOneMinusSrcColor, kZero, kOne, false, false},
    {"MulBlend_HDA", "    s.rgb = (1.0 - s.rgb) * opacity;\n    fragColor = s;", true, kFuncAdd,
     kZero, kOneMinusSrcColor, kZero, kOne, false, false},
    {"AddBlend", "    fragColor = s;", true, kFuncAdd, kConstantColor, kOne, kZero, kOne, false, false},

    // ---------- ColorDodge / Darken / Lighten / Screen ----------
    // The reference ColorDodgeBlend is compiled for two textures, but does not use d, so it is equivalent to a single-texture shader.
    {"ColorDodgeBlend", "    s.rgb = 1.0 / (1.0 - s.rgb * opacity);\n    fragColor = s;", true,
     kFuncAdd, kZero, kSrcColor, kZero, kOne, false, false},
    {"DarkenBlend",
     GAL_D "    d.rgb = mix(d.rgb, min(s.rgb, d.rgb), opacity);\n    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"LightenBlend",
     GAL_D "    d.rgb = mix(d.rgb, max(s.rgb, d.rgb), opacity);\n    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"ScreenBlend", "    s.rgb *= opacity;\n    fragColor = s;", true, kFuncAdd, kOne,
     kOneMinusSrcColor, kZero, kOne, false, false},

    // ---------- Ps ----------
    {"PsAlphaBlend", "    s.a *= opacity;\n    fragColor = s;", true, kFuncAdd, kSrcAlpha,
     kOneMinusSrcAlpha, kZero, kOne, false, false},
    {"PsAddBlend",
     GAL_D "    d.rgb = mix(d.rgb, clamp(s.rgb + d.rgb, 0.0, 1.0), s.a * opacity);\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsSubBlend",
     GAL_D "    d.rgb = mix(d.rgb, clamp(d.rgb + s.rgb - 1.0, 0.0, 1.0), s.a * opacity);\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsMulBlend", "    s.a *= opacity;\n    s.rgb *= s.a;\n    s.rgb += 1.0 - s.a;\n    fragColor = s;",
     true, kFuncAdd, kZero, kSrcColor, kZero, kOne, false, false},
    {"PsScreenBlend", "    s.rgb *= opacity * s.a;\n    fragColor = s;", true, kFuncAdd,
     kOneMinusDstColor, kOne, kZero, kOne, false, false},
    {"PsOverlayBlend",
     GAL_D "    vec3 sd = s.rgb * d.rgb;\n"
           "    s.rgb = step(0.5, d.rgb) * ((s.rgb + d.rgb) * 2.0 - sd * 4.0 - 1.0) + sd * 2.0;\n"
           "    d.rgb = mix(d.rgb, s.rgb, s.a * opacity);\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsHardLightBlend",
     GAL_D "    vec3 sd = s.rgb * d.rgb;\n"
           "    s.rgb = step(0.5, s.rgb) * ((s.rgb + d.rgb) * 2.0 - sd * 4.0 - 1.0) + sd * 2.0;\n"
           "    d.rgb = mix(d.rgb, s.rgb, s.a * opacity);\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsSoftLightBlend",
     GAL_D "    vec3 t = 0.5 / (s.rgb + 0.001);\n"
           "    s.rgb = pow(d.rgb, (1.0 - step(0.5, s.rgb)) * ((1.0 - s.rgb) * 2.0 - t) + t);\n"
           "    d.rgb = mix(d.rgb, s.rgb, s.a * opacity);\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsColorDodgeBlend",
     GAL_D "    s.rgb -= 0.001;\n"
           "    s.rgb = d.rgb / max(1.0 - s.rgb, d.rgb);\n"
           "    d.rgb = mix(d.rgb, s.rgb, s.a * opacity);\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsColorDodge5Blend",
     GAL_D "    s.rgb = s.rgb * s.a * opacity - 0.001;\n"
           "    d.rgb = d.rgb / max(1.0 - s.rgb, d.rgb);\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsColorBurnBlend",
     GAL_D "    s.rgb += 0.001;\n"
           "    s.rgb = 1.0 - min(1.0 - d.rgb, s.rgb) / s.rgb;\n"
           "    d.rgb = mix(d.rgb, s.rgb, s.a * opacity);\n"
           "    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsLightenBlend",
     GAL_D "    d.rgb = mix(d.rgb, max(s.rgb, d.rgb), s.a * opacity);\n    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsDarkenBlend",
     GAL_D "    d.rgb = mix(d.rgb, min(s.rgb, d.rgb), s.a * opacity);\n    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsDiffBlend",
     GAL_D "    d.rgb = mix(d.rgb, abs(s.rgb - d.rgb), s.a * opacity);\n    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsDiff5Blend",
     GAL_D "    s.rgb *= s.a * opacity;\n    d.rgb = abs(s.rgb - d.rgb);\n    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},
    {"PsExclusionBlend",
     GAL_D "    d.rgb += (s.rgb - (s.rgb * d.rgb * 2.0)) * s.a * opacity;\n    fragColor = d;",
     false, kFuncAdd, kOne, kZero, kOne, kZero, false, true},

    {"Fill", "    fragColor = u_color;", false, kFuncAdd, kOne, kZero, kOne, kZero, false, false},
};

#undef GAL_D

std::map<std::string, Method *> &Methods() {
    static std::map<std::string, Method *> methods;
    return methods;
}

// Filter mode is texture-object state, independent of the texture unit. Cache by texture
// name to avoid issuing identical glTexParameteri calls on every draw.
std::map<uint32_t, Filter> &FilterCache() {
    static std::map<uint32_t, Filter> cache;
    return cache;
}

void ResetFilterCache() { FilterCache().clear(); }

void ApplyFilter(Texture *texture, Filter filter) {
    UseTexture(texture->Name());
    auto it = FilterCache().find(texture->Name());
    if (it != FilterCache().end() && it->second == filter) return;
    const GLint mode = filter == Filter::Nearest ? kNearest : kLinear;
    TexParameteri(kTexture2D, kTextureMinFilter, mode);
    TexParameteri(kTexture2D, kTextureMagFilter, mode);
    FilterCache()[texture->Name()] = filter;
}

// Quad bounding box, rounded outward to cover all fragments.
Rect QuadBounds(const float *quad) {
    float minX = quad[0], maxX = quad[0], minY = quad[1], maxY = quad[1];
    for (int i = 1; i < 4; ++i) {
        const float x = quad[i * 2], y = quad[i * 2 + 1];
        minX = std::min(minX, x);
        maxX = std::max(maxX, x);
        minY = std::min(minY, y);
        maxY = std::max(maxY, y);
    }
    return Rect(static_cast<int>(std::floor(minX)), static_cast<int>(std::floor(minY)),
                static_cast<int>(std::ceil(maxX)), static_cast<int>(std::ceil(maxY)));
}

} // namespace

Device &Device::Get() {
    static Device device;
    return device;
}

bool Device::Initialize(int width, int height) {
    if (ready_) return true;
    if (!ContextCreate(width, height)) {
        error_ = "WebGL2 上下文创建失败";
        return false;
    }
    width_ = width;
    height_ = height;
    State().Reset();
    // Initialize may reuse a live context left with blending enabled.
    Disable(kBlend);
    Disable(kScissorTest);
    BlendEquationSeparate(kFuncAdd, kFuncAdd);
    BlendFuncSeparate(kOne, kZero, kOne, kZero);
    // The MaxTextureSize member hides the GL query with the same name, so qualify the call explicitly.
    maxTexture_ = gal::gles::MaxTextureSize();
    if (maxTexture_ <= 0) {
        error_ = "无法查询 GL_MAX_TEXTURE_SIZE";
        return false;
    }
    frameBuffer_ = GenFramebuffer();
    vbo_ = GenBuffer();
    BindBuffer(kArrayBuffer, vbo_);
    BufferData(kArrayBuffer, 0, nullptr, kDynamicDraw);
    EnableVertexAttribArray(0);
    VertexAttribPointer(0, 2, kFloat, false, kVertexStride, 0);
    EnableVertexAttribArray(1);
    VertexAttribPointer(1, 2, kFloat, false, kVertexStride, 8);
    EnableVertexAttribArray(2);
    VertexAttribPointer(2, 2, kFloat, false, kVertexStride, 16);
    if (!EnsureMethods()) return false;
    ResetFilterCache();
    ResetRenderTarget();
    ready_ = true;
    return true;
}

bool Device::EnsureMethods() {
    if (methodsReady_) return true;
    if (!present_.program) {
        present_.name = "Present";
        present_.program = CompileProgram(FragmentSource("    fragColor = s;"), "Present", error_);
        if (!present_.program) return false;
        present_.texture = GetUniformLocation(present_.program, "tex0");
        present_.targetSize = GetUniformLocation(present_.program, "u_targetSize");
        present_.flipY = GetUniformLocation(present_.program, "u_flipY");
    }
    for (const MethodSpec &spec : kMethods) {
        Method *method = new Method();
        method->name = spec.name;
        const int textureCount = spec.targetAsInput ? 2 : 1;
        method->program = CompileProgram(FragmentSource(spec.body, {}, textureCount), spec.name, error_, textureCount);
        if (!method->program) return false;
        method->blend = spec.blend;
        method->targetAsInput = spec.targetAsInput;
        method->equationRGB = spec.equation;
        method->equationA = spec.equation;
        method->srcRGB = spec.srcRGB;
        method->dstRGB = spec.dstRGB;
        method->srcA = spec.srcA;
        method->dstA = spec.dstA;
        method->useBlendColor = spec.blendColor;
        method->texture = GetUniformLocation(method->program, "tex0");
        method->texture1 = GetUniformLocation(method->program, "tex1");
        method->textureCount = textureCount;
        method->textures.resize(textureCount);
        for (int i = 0; i < textureCount; ++i) method->textures[i] = GetUniformLocation(method->program, SamplerName(i));
        method->opacity = GetUniformLocation(method->program, "opacity");
        method->targetSize = GetUniformLocation(method->program, "u_targetSize");
        method->flipY = GetUniformLocation(method->program, "u_flipY");
        method->color = GetUniformLocation(method->program, "u_color");
        Methods()[spec.name] = method;
    }
    methodsReady_ = true;
    return true;
}

Method *Device::CompileMethod(const char *name, const std::string &body, bool targetAsInput,
                              const std::string &declarations, int textureCount, bool perspective) {
    if (auto *existing = FindMethod(name)) {
        if (existing->textureCount != textureCount || existing->perspective != perspective) {
            error_ = std::string(name) + ": render method was compiled with a different texture layout";
            return nullptr;
        }
        return existing;
    }
    auto method = std::make_unique<Method>();
    method->name = name;
    if (textureCount < 1 || textureCount > 15) {
        error_ = "native render methods support 1-15 source textures";
        return nullptr;
    }
    method->program = CompileProgram(FragmentSource(body, declarations, textureCount), name, error_, textureCount, perspective);
    if (!method->program) return nullptr;
    method->targetAsInput = targetAsInput;
    method->textureCount = textureCount;
    method->perspective = perspective;
    method->textures.resize(textureCount);
    for (int i = 0; i < textureCount; ++i) method->textures[i] = GetUniformLocation(method->program, SamplerName(i));
    method->texture = GetUniformLocation(method->program, "tex0");
    method->texture1 = GetUniformLocation(method->program, "tex1");
    method->opacity = GetUniformLocation(method->program, "opacity");
    method->color = GetUniformLocation(method->program, "u_color");
    method->targetSize = GetUniformLocation(method->program, "u_targetSize");
    method->flipY = GetUniformLocation(method->program, "u_flipY");
    auto *result = method.release();
    Methods()[name] = result;
    return result;
}

void Device::Shutdown() {
    ReleaseScratchAll();
    for (auto &entry : Methods()) {
        DeleteProgram(entry.second->program);
        delete entry.second;
    }
    Methods().clear();
    if (present_.program) DeleteProgram(present_.program);
    present_ = Method();
    if (vbo_) DeleteBuffer(vbo_);
    if (frameBuffer_) DeleteFramebuffer(frameBuffer_);
    vbo_ = frameBuffer_ = 0;
    attached_ = 0;
    methodsReady_ = false;
    ready_ = false;
    State().Reset();
    State().valid = false;
}

void Device::Resize(int width, int height) {
    width_ = width;
    height_ = height;
    ContextResize(width, height);
    SetViewport(0, 0, width, height);
}

void Device::OnContextLost() {
    // All GL names become invalid after context loss. Scratch textures contain no persistent
    // data, so discard them to avoid using invalid names as snapshot targets after restoration.
    // The resource layer is responsible for rebuilding game textures.
    Shutdown();
    gles::NotifyContextLost();
    ResetFilterCache();
}

void Device::OnContextRestored() {
    gles::NotifyContextRestored();
    State().Reset();
    frameBuffer_ = GenFramebuffer();
    vbo_ = GenBuffer();
    BindBuffer(kArrayBuffer, vbo_);
    BufferData(kArrayBuffer, 0, nullptr, kDynamicDraw);
    EnableVertexAttribArray(0);
    VertexAttribPointer(0, 2, kFloat, false, kVertexStride, 0);
    EnableVertexAttribArray(1);
    VertexAttribPointer(1, 2, kFloat, false, kVertexStride, 8);
    EnableVertexAttribArray(2);
    VertexAttribPointer(2, 2, kFloat, false, kVertexStride, 16);
    ready_ = EnsureMethods();
    if (!ready_) return;
    ResetFilterCache();
    ResetRenderTarget();
}

Texture *Device::AcquireScratch(int width, int height) {
    if (width <= 0 || height <= 0) return nullptr;
    for (auto &entry : scratch_) {
        if (entry.second) continue;
        if (entry.first->Width() < width || entry.first->Height() < height) continue;
        entry.second = true;
        return entry.first;
    }
    Texture *texture = Texture::Create(width, height, true);
    if (!texture) return nullptr;
    scratch_.emplace_back(texture, true);
    return texture;
}

void Device::ReleaseScratch(Texture *texture) {
    for (auto &entry : scratch_) {
        if (entry.first == texture) {
            entry.second = false;
            return;
        }
    }
}

void Device::ReleaseScratchAll() {
    for (auto &entry : scratch_) entry.first->Release();
    scratch_.clear();
}

Method *Device::FindMethod(const char *name) {
    auto it = Methods().find(name);
    return it == Methods().end() ? nullptr : it->second;
}

Method *Device::GetMethod(Blend blend, bool hda, int opacity) {
    // Match tRenderMethodCache: only bmCopy / bmCopyOnAlpha / bmCopyOnAddAlpha switch to
    // Const* variants when opa is below 255; other methods pass opa as a uniform.
    const bool full = opacity >= 255;
    const char *name = nullptr;
    switch (blend) {
        case Blend::Copy:
            if (!full) name = "ConstAlphaBlend";
            else name = hda ? "CopyColor" : "Copy";
            break;
        case Blend::CopyOnAlpha:
            if (!full) name = "ConstAlphaBlend_d";
            else name = hda ? "CopyColor" : "CopyOpaqueImage";
            break;
        case Blend::Alpha: name = "AlphaBlend"; break;
        case Blend::AlphaOnAlpha: name = "AlphaBlend_d"; break;
        case Blend::Add: name = "AddBlend"; break;
        case Blend::Sub: name = "SubBlend"; break;
        case Blend::Mul: name = hda ? "MulBlend_HDA" : "MulBlend"; break;
        case Blend::Dodge: name = "ColorDodgeBlend"; break;
        case Blend::Darken: name = "DarkenBlend"; break;
        case Blend::Lighten: name = "LightenBlend"; break;
        case Blend::Screen: name = "ScreenBlend"; break;
        case Blend::AddAlpha: name = "AdditiveAlphaBlend"; break;
        case Blend::AddAlphaOnAddAlpha: name = "AdditiveAlphaBlend_a"; break;
        case Blend::AddAlphaOnAlpha:
            // This entry is commented out in the reference Info[bmAddAlphaOnAddAlpha], and
            // no method is registered. Report it as unsupported instead of silently
            // substituting another mode.
            error_ = "bmAddAlphaOnAlpha 未实现（参考渲染器同样未注册）";
            return nullptr;
        case Blend::AlphaOnAddAlpha: name = "AlphaBlend_a"; break;
        case Blend::CopyOnAddAlpha:
            name = full ? "CopyOpaqueImage" : "ConstAlphaBlend_a";
            break;
        case Blend::PsNormal: name = "PsAlphaBlend"; break;
        case Blend::PsAdditive: name = "PsAddBlend"; break;
        case Blend::PsSubtractive: name = "PsSubBlend"; break;
        case Blend::PsMultiplicative: name = "PsMulBlend"; break;
        case Blend::PsScreen: name = "PsScreenBlend"; break;
        case Blend::PsOverlay: name = "PsOverlayBlend"; break;
        case Blend::PsHardLight: name = "PsHardLightBlend"; break;
        case Blend::PsSoftLight: name = "PsSoftLightBlend"; break;
        case Blend::PsColorDodge: name = "PsColorDodgeBlend"; break;
        case Blend::PsColorDodge5: name = "PsColorDodge5Blend"; break;
        case Blend::PsColorBurn: name = "PsColorBurnBlend"; break;
        case Blend::PsLighten: name = "PsLightenBlend"; break;
        case Blend::PsDarken: name = "PsDarkenBlend"; break;
        case Blend::PsDifference: name = "PsDiffBlend"; break;
        case Blend::PsDifference5: name = "PsDiff5Blend"; break;
        case Blend::PsExclusion: name = "PsExclusionBlend"; break;
    }
    return name ? FindMethod(name) : nullptr;
}

bool Device::SetRenderTarget(Texture *texture) {
    if (!ready_ || !texture) return false;
    // The only attachment point: any draw/copy into this texture invalidates Point's CPU snapshot.
    texture->InvalidatePointCache();
    SetFramebuffer(frameBuffer_);
    if (attached_ != texture->Name()) {
        FramebufferTexture2D(kFramebuffer, kColorAttachment0, kTexture2D, texture->Name(), 0);
        attached_ = texture->Name();
        if (kValidateFramebuffer && !framebufferValidated_) {
            if (CheckFramebufferStatus(kFramebuffer) != kFramebufferComplete) {
                error_ = "framebuffer 不完整";
                return false;
            }
            framebufferValidated_ = true;
        }
    }
    SetViewport(0, 0, texture->Width(), texture->Height());
    return true;
}

void Device::ForgetTexture(uint32_t name) {
    if (attached_ == name) ResetRenderTarget();
}

void Device::ResetRenderTarget() {
    SetFramebuffer(0);
    attached_ = 0;
    SetViewport(0, 0, width_, height_);
}

void Device::Present(Texture *texture, Filter filter) {
    if (!texture) return;
    const Rect full(0, 0, texture->Width(), texture->Height());
    Present(texture, full, full, width_, height_, filter);
}

void Device::Present(Texture *texture, const Rect &source, const Rect &destination,
                     int logicalWidth, int logicalHeight, Filter filter) {
    if (!ready_ || !texture) return;
    ResetRenderTarget();
    Method *method = &present_;
    UseProgramCached(method->program);
    Uniform1i(method->texture, 0);
    ActiveTexture(0);
    ApplyFilter(texture, filter);
    SetBlend(false, kFuncAdd, kFuncAdd, kOne, kZero, kOne, kZero);
    SetScissor(false, 0, 0, 0, 0);

    const float l = destination.left, t = destination.top;
    const float r = destination.right, b = destination.bottom;
    const float u0 = float(source.left) / texture->Width(), v0 = float(source.top) / texture->Height();
    const float u1 = float(source.right) / texture->Width(), v1 = float(source.bottom) / texture->Height();
    const float vertices[36] = {
        l, t, u0, v0, 0.f, 0.f,
        r, t, u1, v0, 0.f, 0.f,
        l, b, u0, v1, 0.f, 0.f,
        l, b, u0, v1, 0.f, 0.f,
        r, t, u1, v0, 0.f, 0.f,
        r, b, u1, v1, 0.f, 0.f,
    };
    // Flip Y only when presenting to the canvas: canvas origin is bottom-left, while the TVP layer origin is top-left.
    DrawVertices(logicalWidth, logicalHeight, method, vertices, 6, -1.f);
}

void Device::Clear(float r, float g, float b, float a) {
    if (!ready_) return;
    // Window-level clear: clear the default framebuffer without touching offscreen targets.
    ResetRenderTarget();
    ColorMask(true, true, true, true);
    ClearColor(r, g, b, a);
    gles::Clear(kColorBufferBit);
}

void Device::BindShaderState(Method *method, int opacity) {
    UseProgramCached(method->program);
    ActiveTexture(0);
    Uniform1i(method->texture, 0);
    if (method->useBlendColor) {
        const float value = static_cast<float>(opacity) / 255.f;
        BlendColor(value, value, value, value);
    } else if (method->opacity >= 0) {
        Uniform1f(method->opacity, static_cast<float>(opacity) / 255.f);
    }
    SetBlend(method->blend, method->equationRGB, method->equationA, method->srcRGB,
             method->dstRGB, method->srcA, method->dstA);
}

void Device::DrawVertices(int targetWidth, int targetHeight, Method *method, const float *vertices,
                          int count, float flipY, int textureCount) {
    Uniform2f(method->targetSize, static_cast<float>(targetWidth),
              static_cast<float>(targetHeight));
    Uniform1f(method->flipY, flipY);
    BindBuffer(kArrayBuffer, vbo_);
    const int stride = (2 + textureCount * 2) * sizeof(float);
    BufferData(kArrayBuffer, static_cast<uint32_t>(count * stride), vertices, kDynamicDraw);
    EnableVertexAttribArray(0);
    VertexAttribPointer(0, 2, kFloat, false, stride, 0);
    for (int i = 0; i < textureCount; ++i) {
        EnableVertexAttribArray(i + 1);
        VertexAttribPointer(i + 1, 2, kFloat, false, stride, (i + 1) * 2 * sizeof(float));
    }
    DrawArrays(kTriangles, 0, count);
    ++draws_;
}

void Device::DrawTriangles(Texture *dst, const std::vector<Texture *> &sources,
                          const std::vector<float> &vertices, int vertexCount,
                          Method *method, int opacity, const Rect *clip,
                          Filter filter, const std::function<void()> &applyParameters,
                          Texture *targetInput) {
    if (!ready_ || !dst || !method || sources.empty() || vertexCount < 3 || vertexCount % 3) return;
    std::vector<Texture *> inputs = sources;
    if (targetInput) inputs.push_back(targetInput);
    if (inputs.size() != static_cast<size_t>(method->textureCount)) {
        error_ = "render method texture count does not match submitted sources";
        return;
    }
    const Rect area = clip ? clip->Intersect(Rect(0, 0, dst->Width(), dst->Height()))
                           : Rect(0, 0, dst->Width(), dst->Height());
    if (area.Empty() || !SetRenderTarget(dst)) return;
    SetScissor(true, area.left, area.top, area.Width(), area.Height());
    BindShaderState(method, opacity);
    if (applyParameters) applyParameters();
    for (size_t i = 0; i < inputs.size(); ++i) {
        ActiveTexture(static_cast<int>(i));
        ApplyFilter(inputs[i], filter);
        if (i < method->textures.size() && method->textures[i] >= 0)
            Uniform1i(method->textures[i], static_cast<int>(i));
    }
    ActiveTexture(0);
    Uniform2f(method->targetSize, static_cast<float>(dst->Width()), static_cast<float>(dst->Height()));
    Uniform1f(method->flipY, 1.f);
    const int positionFloats = method->perspective ? 3 : 2;
    const int stride = (positionFloats + 2 * static_cast<int>(inputs.size())) * sizeof(float);
    BindBuffer(kArrayBuffer, vbo_);
    BufferData(kArrayBuffer, static_cast<uint32_t>(vertices.size() * sizeof(float)), vertices.data(), kDynamicDraw);
    EnableVertexAttribArray(0);
    VertexAttribPointer(0, positionFloats, kFloat, false, stride, 0);
    for (size_t i = 0; i < inputs.size(); ++i) {
        EnableVertexAttribArray(static_cast<GLuint>(i + 1));
        VertexAttribPointer(static_cast<GLuint>(i + 1), 2, kFloat, false, stride,
                            positionFloats * sizeof(float) + i * 2 * sizeof(float));
    }
    DrawArrays(kTriangles, 0, vertexCount);
    ++draws_;
    SetScissor(false, 0, 0, 0, 0);
}

void Device::DrawQuad(Texture *dst, Texture *src, const Rect &srcRect, const float *quad,
                      Blend blend, bool hda, int opacity, const Rect *clip, Filter filter) {
    if (opacity <= 0) return;
    auto *method = GetMethod(blend, hda, opacity);
    DrawQuad(dst, src, srcRect, quad, method, opacity, clip, filter);
}

void Device::DrawQuad(Texture *dst, Texture *src, const Rect &srcRect, const float *quad,
                      Method *method, int opacity, const Rect *clip, Filter filter,
                      const std::function<void()> &applyParameters, Texture *referenceTarget,
                      Texture *secondSource, const Rect *secondRect) {
    if (!ready_ || !dst || !src || srcRect.Empty() || !quad) return;
    Rect area = clip ? clip->Intersect(Rect(0, 0, dst->Width(), dst->Height()))
                     : Rect(0, 0, dst->Width(), dst->Height());
    if (area.Empty()) return;

    if (!method) {
        if (error_.empty()) error_ = "缺少渲染方法";
        return;
    }

    // When source and target are the same texture, it cannot be sampled directly: WebGL2
    // forbids using one texture as both an attachment and a sampling source. The reference
    // also copies the region to a temporary texture first (GetTempTexture2D).
    Texture *source = src;
    Rect sourceRect = srcRect;
    Texture *sourceCopy = nullptr;
    if (src == dst) {
        // A pooled scratch texture may be larger than the needed region. Copy srcRect to its
        // top-left corner and record the source rectangle using the copied dimensions, not
        // the scratch texture dimensions.
        const int copyW = srcRect.Width(), copyH = srcRect.Height();
        sourceCopy = AcquireScratch(copyW, copyH);
        if (!sourceCopy) { error_ = "临时纹理不足"; return; }
        Copy(sourceCopy, src, srcRect, 0, 0, nullptr, Filter::Nearest);
        source = sourceCopy;
        sourceRect = Rect(0, 0, copyW, copyH);
    }

    // For target-as-input, first snapshot the region about to be overwritten, then read it
    // using a second set of texture coordinates to obtain the pixels from before this draw.
    Texture *targetCopy = nullptr;
    Rect targetRect;
    if (method->targetAsInput && !secondSource) {
        targetRect = QuadBounds(quad).Intersect(area);
        if (targetRect.Empty()) {
            if (sourceCopy) ReleaseScratch(sourceCopy);
            return;
        }
        targetCopy = AcquireScratch(targetRect.Width(), targetRect.Height());
        if (!targetCopy) {
            if (sourceCopy) ReleaseScratch(sourceCopy);
            error_ = "临时纹理不足";
            return;
        }
        Copy(targetCopy, referenceTarget ? referenceTarget : dst, targetRect, 0, 0, nullptr, Filter::Nearest);
    }

    if (SetRenderTarget(dst)) {
        SetScissor(true, area.left, area.top, area.Width(), area.Height());
        BindShaderState(method, opacity);
        if (applyParameters) applyParameters();
        ApplyFilter(source, filter);
        if (targetCopy || secondSource) {
            if (method->texture1 >= 0) Uniform1i(method->texture1, 1);
            ActiveTexture(1);
            ApplyFilter(secondSource ? secondSource : targetCopy, Filter::Nearest);
            ActiveTexture(0);
        }
        const float invW = 1.f / static_cast<float>(source->Width());
        const float invH = 1.f / static_cast<float>(source->Height());
        const float u0 = sourceRect.left * invW, v0 = sourceRect.top * invH;
        const float u1 = sourceRect.right * invW, v1 = sourceRect.bottom * invH;
        // quad: lt, rt, lb, rb (TVP screen coordinates, with y increasing downward).
        // The snapshot is copied 1:1 to the scratch texture's top-left corner. Calculate UVs
        // using the full scratch texture dimensions so each fragment center lands at the
        // center of the corresponding texel.
        const float tw = targetCopy ? 1.f / static_cast<float>(targetCopy->Width()) : 0.f;
        const float th = targetCopy ? 1.f / static_cast<float>(targetCopy->Height()) : 0.f;
        auto du = [&](float x) { return (x - static_cast<float>(targetRect.left)) * tw; };
        auto dv = [&](float y) { return (y - static_cast<float>(targetRect.top)) * th; };
        const float px[4] = {quad[0], quad[2], quad[4], quad[6]};
        const float py[4] = {quad[1], quad[3], quad[5], quad[7]};
        const float su[2] = {u0, u1}, sv[2] = {v0, v1};
        // Vertex order: lt, rt, lb / lb, rt, rb.
        const int order[6] = {0, 1, 2, 2, 1, 3};
        const int uvIndex[4][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 1}};
        float vertices[36];
        for (int i = 0; i < 6; ++i) {
            const int corner = order[i];
            float *out = vertices + i * kVertexFloats;
            out[0] = px[corner];
            out[1] = py[corner];
            out[2] = su[uvIndex[corner][0]];
            out[3] = sv[uvIndex[corner][1]];
            out[4] = secondSource
                ? float(uvIndex[corner][0] ? secondRect->right : secondRect->left) / secondSource->Width()
                : targetCopy ? du(px[corner]) : 0.f;
            out[5] = secondSource
                ? float(uvIndex[corner][1] ? secondRect->bottom : secondRect->top) / secondSource->Height()
                : targetCopy ? dv(py[corner]) : 0.f;
        }
        DrawVertices(dst->Width(), dst->Height(), method, vertices, 6);
        SetScissor(false, 0, 0, 0, 0);
    }

    if (targetCopy) ReleaseScratch(targetCopy);
    if (sourceCopy) ReleaseScratch(sourceCopy);
}

void Device::DrawRect(Texture *dst, Texture *src, const Rect &srcRect, int x, int y,
                      Blend blend, bool hda, int opacity, const Rect *clip, Filter filter) {
    const float w = static_cast<float>(srcRect.Width());
    const float h = static_cast<float>(srcRect.Height());
    const float quad[8] = {
        static_cast<float>(x), static_cast<float>(y),
        static_cast<float>(x) + w, static_cast<float>(y),
        static_cast<float>(x), static_cast<float>(y) + h,
        static_cast<float>(x) + w, static_cast<float>(y) + h,
    };
    DrawQuad(dst, src, srcRect, quad, blend, hda, opacity, clip, filter);
}

void Device::Copy(Texture *dst, Texture *src, const Rect &srcRect, int x, int y,
                  const Rect *clip, Filter filter) {
    DrawRect(dst, src, srcRect, x, y, Blend::Copy, false, 255, clip, filter);
}

void Device::Scale(Texture *dst, Texture *src, const Rect &srcRect, const Rect &dstRect,
                   const Rect *clip, Filter filter) {
    const float quad[8] = {
        static_cast<float>(dstRect.left), static_cast<float>(dstRect.top),
        static_cast<float>(dstRect.right), static_cast<float>(dstRect.top),
        static_cast<float>(dstRect.left), static_cast<float>(dstRect.bottom),
        static_cast<float>(dstRect.right), static_cast<float>(dstRect.bottom),
    };
    DrawQuad(dst, src, srcRect, quad, Blend::Copy, false, 255, clip, filter);
}

void Device::Fill(Texture *dst, const Rect &rect, uint32_t argb, const Rect *clip) {
    if (!ready_ || !dst || rect.Empty()) return;
    Rect area = clip ? clip->Intersect(Rect(0, 0, dst->Width(), dst->Height()))
                     : Rect(0, 0, dst->Width(), dst->Height());
    if (area.Empty()) return;
    Method *method = FindMethod("Fill");
    if (!method || !SetRenderTarget(dst)) return;
    SetScissor(true, area.left, area.top, area.Width(), area.Height());
    UseProgramCached(method->program);
    const float r = ((argb >> 16) & 255) / 255.f, g = ((argb >> 8) & 255) / 255.f;
    const float b = (argb & 255) / 255.f, a = ((argb >> 24) & 255) / 255.f;
    Uniform4f(method->color, r, g, b, a);
    SetBlend(false, kFuncAdd, kFuncAdd, kOne, kZero, kOne, kZero);
    const float x0 = static_cast<float>(rect.left), y0 = static_cast<float>(rect.top);
    const float x1 = static_cast<float>(rect.right), y1 = static_cast<float>(rect.bottom);
    const float vertices[36] = {
        x0, y0, 0.f, 0.f, 0.f, 0.f, x1, y0, 0.f, 0.f, 0.f, 0.f, x0, y1, 0.f, 0.f, 0.f, 0.f,
        x0, y1, 0.f, 0.f, 0.f, 0.f, x1, y0, 0.f, 0.f, 0.f, 0.f, x1, y1, 0.f, 0.f, 0.f, 0.f,
    };
    DrawVertices(dst->Width(), dst->Height(), method, vertices, 6);
    SetScissor(false, 0, 0, 0, 0);
}

void Device::ClearTexture(Texture *dst, const Rect *clip) {
    if (!ready_ || !dst || !SetRenderTarget(dst)) return;
    if (clip) {
        const Rect area = clip->Intersect(Rect(0, 0, dst->Width(), dst->Height()));
        if (area.Empty()) return;
        SetScissor(true, area.left, area.top, area.Width(), area.Height());
    }
    ColorMask(true, true, true, true);
    ClearColor(0.f, 0.f, 0.f, 0.f);
    gles::Clear(kColorBufferBit);
    if (clip) SetScissor(false, 0, 0, 0, 0);
}

} // namespace gal::render
