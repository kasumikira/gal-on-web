#pragma once
// Native rendering backend: Cocos-free counterparts to iTVPTexture2D,
// iTVPRenderManager, and RenderManager_ogl. The interface follows the reference
// implementation (textures, render targets, render methods, and draw calls), while
// the implementation uses the GLES subset available in WebGL2.
//
// Main platform differences; this is not yet a direct replacement for the original
// Layer interface:
// 1. GetAdapterTexture and AdapterTexture2D are absent; a texture is just a texture.
// 2. gles::StateCache replaces cocos2d::GL state caching.
// 3. The platform explicitly reports context loss/restoration; EventDispatcher is not used.
#include "render/gles.h"
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace gal::render {

struct Rect {
    int left = 0, top = 0, right = 0, bottom = 0;
    Rect() = default;
    Rect(int l, int t, int r, int b) : left(l), top(t), right(r), bottom(b) {}
    int Width() const { return right - left; }
    int Height() const { return bottom - top; }
    bool Empty() const { return right <= left || bottom <= top; }
    Rect Intersect(const Rect &o) const {
        Rect r(left > o.left ? left : o.left, top > o.top ? top : o.top,
               right < o.right ? right : o.right, bottom < o.bottom ? bottom : o.bottom);
        if (r.right < r.left) r.right = r.left;
        if (r.bottom < r.top) r.bottom = r.top;
        return r;
    }
    Rect Offset(int x, int y) const { return Rect(left + x, top + y, right + x, bottom + y); }
    bool operator==(const Rect &o) const { return left == o.left && top == o.top && right == o.right && bottom == o.bottom; }
};

// Blend modes. Values exactly match tTVPBBBltMethod in the reference implementation.
// Layer drawing passes the bm encoding directly, without a second numbering scheme.
enum class Blend : int {
    Copy = 0,          // bmCopy              Use "ConstAlphaBlend" when opa < 255.
    CopyOnAlpha,       // bmCopyOnAlpha       Treat the source as opaque; account for target alpha.
    Alpha,             // bmAlpha             "AlphaBlend"
    AlphaOnAlpha,      // bmAlphaOnAlpha      "AlphaBlend_d"
    Add,               // bmAdd               "AddBlend"
    Sub,               // bmSub               "SubBlend"
    Mul,               // bmMul               "MulBlend" / "MulBlend_HDA"
    Dodge,             // bmDodge             "ColorDodgeBlend"
    Darken,            // bmDarken            "DarkenBlend"
    Lighten,           // bmLighten           "LightenBlend"
    Screen,            // bmScreen            "ScreenBlend"
    AddAlpha,          // bmAddAlpha          "AdditiveAlphaBlend"
    AddAlphaOnAddAlpha,// bmAddAlphaOnAddAlpha "AdditiveAlphaBlend_a"
    AddAlphaOnAlpha,   // bmAddAlphaOnAlpha   Not registered in the reference; report unsupported.
    AlphaOnAddAlpha,   // bmAlphaOnAddAlpha   "AlphaBlend_a"
    CopyOnAddAlpha,    // bmCopyOnAddAlpha    "CopyOpaqueImage" / "ConstAlphaBlend_a"
    PsNormal,          // bmPsNormal          "PsAlphaBlend"
    PsAdditive,        // bmPsAdditive        "PsAddBlend"
    PsSubtractive,     // bmPsSubtractive     "PsSubBlend"
    PsMultiplicative,  // bmPsMultiplicative  "PsMulBlend"
    PsScreen,          // bmPsScreen          "PsScreenBlend"
    PsOverlay,         // bmPsOverlay         "PsOverlayBlend"
    PsHardLight,       // bmPsHardLight       "PsHardLightBlend"
    PsSoftLight,       // bmPsSoftLight       "PsSoftLightBlend"
    PsColorDodge,      // bmPsColorDodge      "PsColorDodgeBlend"
    PsColorDodge5,     // bmPsColorDodge5     "PsColorDodge5Blend"
    PsColorBurn,       // bmPsColorBurn       "PsColorBurnBlend"
    PsLighten,         // bmPsLighten         "PsLightenBlend"
    PsDarken,          // bmPsDarken          "PsDarkenBlend"
    PsDifference,      // bmPsDifference      "PsDiffBlend"
    PsDifference5,     // bmPsDifference5     "PsDiff5Blend"
    PsExclusion,       // bmPsExclusion       "PsExclusionBlend"
};

// Sampling modes: the reference GL backend always uses GL_LINEAR (it does not read
// StretchType); callers handle nearest-neighbor scaling on the CPU or in a separate
// program. Keep the distinction explicit here for pixel comparisons.
enum class Filter { Nearest, Linear };

// Texture. Reference-counting and IsIndependent semantics match iTVPTexture2D.
// EnsureWritable implements copy-on-write, corresponding to tTVPNativeBaseBitmap::Assign.
class Texture {
public:
    static Texture *Create(int width, int height, bool renderTarget = false);
    static Texture *FromRGBA(const void *pixels, int width, int height, int pitch);

    void AddRef() { ++references_; }
    void Release();
    // Another reference to the same storage (an alias view after iTVPTexture2D::AddRef).
    Texture *Share() { AddRef(); return this; }
    // A new texture containing a copy of the contents, with a reference count of 1.
    Texture *Clone() const;
    // Ensure exclusive storage. If the result is not this, the caller's old reference has
    // already been consumed and the caller only needs to replace the pointer.
    Texture *EnsureWritable();
    bool IsIndependent() const { return references_ == 1; }

    int Width() const { return width_; }
    int Height() const { return height_; }
    uint32_t Name() const { return name_; }
    bool RenderTarget() const { return renderTarget_; }
    bool IsOpaque() const { return opaque_; }
    void SetOpaque(bool value) { opaque_ = value; }

    // Straight-alpha RGBA8; pitch is measured in bytes.
    void Update(const void *pixels, int pitch, const Rect &rect);
    void ReadAll(void *out) const;
    uint32_t Point(int x, int y) const;
    void SetPoint(int x, int y, uint32_t argb);

    // Any write (CPU upload or attachment as a render target) invalidates Point's full-image snapshot.
    void InvalidatePointCache() {
        // Point() also attaches a render target to read pixels. That is not a write and
        // must not invalidate the snapshot; otherwise every readback resets the consecutive
        // point-query count and falls back to reading one pixel at a time.
        if (readingPoint_) return;
        pointCacheValid_ = false;
        pointProbes_ = 0;
    }

private:
    Texture(int width, int height, bool renderTarget);
    ~Texture();
    int references_ = 1;
    int width_ = 0, height_ = 0;
    bool opaque_ = false, renderTarget_ = false;
    uint32_t name_ = 0;
    bool bound_ = false;
    // Full-image CPU snapshot used by Point(). Scripts have two query patterns with
    // opposite costs:
    //   a) Scan the whole image (up to tens of thousands of queries at startup): read it
    //      once, then query from memory.
    //   b) Query one or two pixels per frame (transitions, hit testing): reading one pixel
    //      at a time is cheaper.
    // A single 1x1 readPixels call is a millisecond-scale pipeline sync point, while reading
    // a full 1080p image transfers 8 MB. Neither is cheap, so adapt based on consecutive
    // queries within the same generation.
    mutable std::vector<uint8_t> pointCache_;
    mutable bool pointCacheValid_ = false;
    mutable int pointProbes_ = 0;
    mutable bool readingPoint_ = false;
};

// Render target: attach a texture to the shared FBO. The reference also uses a single _FBO.
class Target {
public:
    explicit Target(Texture *texture);
    ~Target();
    bool Bind();
    Texture *GetTexture() const { return texture_; }
    void Invalidate() { attached_ = false; }

private:
    Texture *texture_ = nullptr;
    bool attached_ = false;
};

// A compiled shader program and its blend state.
struct Method {
    std::string name;
    uint32_t program = 0;
    bool blend = false;
    // Target as input (the reference's tar_as_src): shader value d comes from a snapshot
    // of the target, so vertices need a second set of texture coordinates. Used by the _d
    // and Ps families.
    bool targetAsInput = false;
    gles::GLenum equationRGB = gles::kFuncAdd, equationA = gles::kFuncAdd;
    gles::GLenum srcRGB = gles::kOne, dstRGB = gles::kZero;
    gles::GLenum srcA = gles::kOne, dstA = gles::kZero;
    bool useBlendColor = false;
    int opacity = -1;   // Uniform location.
    int texture = -1;   // Uniform location (tex0).
    int texture1 = -1;  // Uniform location (tex1; targetAsInput only).
    std::vector<int> textures; // sampler uniforms, one per compiled source
    int textureCount = 2;
    int targetSize = -1;
    int transform = -1;
    int blendColor = -1;
    int flipY = -1;
    int color = -1;
    int perspectiveMatrix = -1;
    bool perspective = false;
};

class Device {
public:
    static Device &Get();
    bool Initialize(int width, int height);
    void Shutdown();
    bool Ready() const { return ready_; }

    void Resize(int width, int height);
    int Width() const { return width_; }
    int Height() const { return height_; }
    int MaxTextureSize() const { return maxTexture_; }

    // The platform adapter calls these on context loss/restoration (window notifications,
    // webglcontextlost events).
    void OnContextLost();
    void OnContextRestored();

    Method *GetMethod(Blend blend, bool hda, int opacity = 255);
    Method *FindMethod(const char *name);
    Method *CompileMethod(const char *name, const std::string &body, bool targetAsInput,
                          const std::string &declarations = {}, int textureCount = 2,
                          bool perspective = false);
    // Switch targets on the shared FBO, matching TVPSetRenderTarget in the reference.
    bool SetRenderTarget(Texture *texture);
    void ResetRenderTarget();
    // Detach the texture before destruction to avoid leaving an incomplete framebuffer.
    void ForgetTexture(uint32_t name);
    // Present to the default framebuffer; Y is flipped only here.
    void Present(Texture *texture, Filter filter = Filter::Linear);
    void Present(Texture *texture, const Rect &source, const Rect &destination,
                 int logicalWidth, int logicalHeight, Filter filter = Filter::Linear);
    void Clear(float r, float g, float b, float a);

    // Draw a textured quad to the target texture. quad contains 8 floats: lt, rt, lb, rb.
    void DrawQuad(Texture *dst, Texture *src, const Rect &srcRect, const float *quad,
                  Blend blend, bool hda, int opacity, const Rect *clip,
                  Filter filter = Filter::Linear);
    // The original RenderManager selects a method and applies its parameters.
    // Keep that interface independent of the convenience bm dispatch above.
    void DrawQuad(Texture *dst, Texture *src, const Rect &srcRect, const float *quad,
                  Method *method, int opacity, const Rect *clip, Filter filter,
                  const std::function<void()> &applyParameters = {}, Texture *referenceTarget = nullptr,
                  Texture *secondSource = nullptr, const Rect *secondRect = nullptr);
    void DrawTriangles(Texture *dst, const std::vector<Texture *> &sources,
                       const std::vector<float> &vertices, int vertexCount,
                       Method *method, int opacity, const Rect *clip,
                       Filter filter, const std::function<void()> &applyParameters = {},
                       Texture *targetInput = nullptr);
    // Axis-aligned draw using integer pixel coordinates.
    void DrawRect(Texture *dst, Texture *src, const Rect &srcRect, int x, int y,
                  Blend blend, bool hda, int opacity, const Rect *clip,
                  Filter filter = Filter::Linear);
    void Copy(Texture *dst, Texture *src, const Rect &srcRect, int x, int y,
              const Rect *clip, Filter filter = Filter::Nearest);
    void Scale(Texture *dst, Texture *src, const Rect &srcRect, const Rect &dstRect,
               const Rect *clip, Filter filter = Filter::Linear);
    void Fill(Texture *dst, const Rect &rect, uint32_t argb, const Rect *clip);
    void ClearTexture(Texture *dst, const Rect *clip);

    uint64_t DrawCount() const { return draws_; }
    const std::string &LastError() const { return error_; }
    void SetError(const std::string &text) { error_ = text; }

private:
    Device() = default;
    bool EnsureMethods();
    void BindShaderState(Method *method, int opacity);
    void DrawVertices(int targetWidth, int targetHeight, Method *method, const float *vertices,
                      int count, float flipY = 1.f, int textureCount = 2);
    // Scratch texture pool shared by target snapshots and self-copies; reuse textures when large enough.
    Texture *AcquireScratch(int width, int height);
    void ReleaseScratch(Texture *texture);
    void ReleaseScratchAll();

    bool ready_ = false;
    int width_ = 0, height_ = 0, maxTexture_ = 0;
    uint32_t vbo_ = 0, ibo_ = 0;
    uint32_t frameBuffer_ = 0;
    uint32_t attached_ = 0;   // Texture name currently attached to the shared FBO.
    bool framebufferValidated_ = false;  // Used only when kValidateFramebuffer is enabled (disabled by default).
    bool methodsReady_ = false;
    uint64_t draws_ = 0;
    std::string error_;
    Method present_;
    Method fill_;
    std::vector<std::pair<Texture *, bool>> scratch_;
};

// C entry points for JS bindings and test pages.
extern "C" {
int gal_render_initialize(int width, int height);
void gal_render_shutdown();
void gal_render_resize(int width, int height);
int gal_render_max_texture();
int gal_render_texture_create(int width, int height, int renderTarget);
int gal_render_texture_from_pixels(int width, int height, int pitch, const void *pixels);
void gal_render_texture_release(int id);
int gal_render_texture_share(int id);
int gal_render_texture_clone(int id);
// Copy-on-write: return a new texture ID when storage is shared, or the original ID when exclusive.
int gal_render_texture_writable(int id);
int gal_render_texture_width(int id);
int gal_render_texture_height(int id);
int gal_render_texture_independent(int id);
void gal_render_texture_update(int id, int x, int y, int width, int height, const void *pixels);
void gal_render_texture_read(int id, void *out);
void gal_render_texture_fill(int id, int left, int top, int right, int bottom, unsigned int argb);
void gal_render_texture_clear(int id);
void gal_render_clear(float r, float g, float b, float a);
void gal_render_present(int id, int filter);
void gal_render_copy(int dst, int src, int left, int top, int right, int bottom, int x, int y, int filter);
void gal_render_scale(int dst, int src, int sl, int st, int sr, int sb, int dl, int dt, int dr, int db, int filter);
// blend uses the tTVPBBBltMethod encoding (0=bmCopy ... 31=bmPsExclusion).
void gal_render_draw_rect(int dst, int src, int sl, int st, int sr, int sb, int x, int y,
                          int blend, int hda, int opacity, int clipL, int clipT, int clipR, int clipB, int filter);
void gal_render_draw_quad(int dst, int src, int sl, int st, int sr, int sb, const float *quad,
                          int blend, int hda, int opacity, int clipL, int clipT, int clipR, int clipB, int filter);
void gal_render_read_canvas(void *out);
unsigned long long gal_render_draw_count();
int gal_render_last_error(void *out, int capacity);
void gal_render_context_lost();
void gal_render_context_restored();
}

} // namespace gal::render
