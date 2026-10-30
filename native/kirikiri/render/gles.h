#pragma once
// GLES subset: the only WebGL2 entry point for the native rendering backend.
//
// Declare only GLES 3.0 calls directly available in WebGL2. Do not emulate desktop OpenGL
// extensions, immediate mode, pixel-format conversion, or alpha testing. Calls go through
// Emscripten GLES and use the WebGL2 context created by JS.
//
// Conventions:
// - Coordinates follow the original TVP convention: texture row 0 is the image top. When
//   rendering to an FBO, GL y matches TVP y (no flip); flip once when presenting to canvas.
// - Texel memory is always straight-alpha RGBA8, matching the reference OpenGL backend's
//   glBlendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA) semantics.
#include <cstdint>
#include <string>

namespace gal::gles {

using GLenum = uint32_t;
using GLuint = uint32_t;
using GLint = int32_t;

// Only constants used by this backend are listed; values match GLES 3.0.
enum : GLenum {
    kZero = 0, kOne = 1,
    kSrcColor = 0x0300, kOneMinusSrcColor = 0x0301,
    kSrcAlpha = 0x0302, kOneMinusSrcAlpha = 0x0303,
    kDstAlpha = 0x0304, kOneMinusDstAlpha = 0x0305,
    kDstColor = 0x0306, kOneMinusDstColor = 0x0307,
    kConstantColor = 0x8001, kOneMinusConstantColor = 0x8002,
    kConstantAlpha = 0x8003, kOneMinusConstantAlpha = 0x8004,
    kFuncAdd = 0x8006, kFuncSubtract = 0x800A, kFuncReverseSubtract = 0x800B,
    kMin = 0x8007, kMax = 0x8008,

    kBlend = 0x0BE2, kCullFace = 0x0B44, kDepthTest = 0x0B71,
    kScissorTest = 0x0C11, kStencilTest = 0x0B90,

    kTexture2D = 0x0DE1, kFramebuffer = 0x8D40, kRenderbuffer = 0x8D41,
    kColorAttachment0 = 0x8CE0,
    kDepthStencilAttachment = 0x821A, kDepth24Stencil8 = 0x88F0,
    kFramebufferComplete = 0x8CD5,
    kTextureMinFilter = 0x2801, kTextureMagFilter = 0x2800,
    kTextureWrapS = 0x2802, kTextureWrapT = 0x2803,
    kNearest = 0x2600, kLinear = 0x2601,
    kClampToEdge = 0x812F,
    kRgba = 0x1908, kRgba8 = 0x8058, kUnsignedByte = 0x1401,

    kArrayBuffer = 0x8892, kElementArrayBuffer = 0x8893,
    kStaticDraw = 0x88E4, kDynamicDraw = 0x88E8,
    kFloat = 0x1406, kUnsignedShort = 0x1403,
    kTriangles = 0x0004,

    kUnpackAlignment = 0x0CF5, kUnpackRowLength = 0x0CF2,
    kPackAlignment = 0x0D05,
    kColorBufferBit = 0x4000,
    kMaxTextureSize = 0x0D33,
    kRenderbufferWidth = 0x8D42, kRenderbufferHeight = 0x8D43,

    kVertexShader = 0x8B31, kFragmentShader = 0x8B30,
    kCompileStatus = 0x8B81, kLinkStatus = 0x8B82,
    kActiveUniforms = 0x8B86,
    kNoError = 0,
};

// Texture format: the backend supports only RGBA8. Convert other formats at the decode/upload boundary.
enum class PixelFormat { RGBA8 };

// Context-loss state.
enum class ContextState { Ready, Lost, Restored };

// Low-level GLES interface; JS creates the context and passes it to Emscripten.
bool ContextCreate(int width, int height);
void ContextResize(int width, int height);
bool ContextLost();
// Called by the platform after context loss; on restoration, clear the state cache and
// recreate persistent objects.
void NotifyContextLost();
void NotifyContextRestored();

int MaxTextureSize();
int MaxRenderbufferSize();

GLuint GenTexture();
void DeleteTexture(GLuint texture);
void BindTexture(GLenum target, GLuint texture);
void ActiveTexture(int unit);
void TexParameteri(GLenum target, GLenum pname, GLint param);
// Texture contents are always straight-alpha RGBA8. Format conversion belongs at the upload
// boundary, not in the binding layer.
void TexImage2D(int width, int height, const void *pixels);
void TexSubImage2D(int x, int y, int width, int height, const void *pixels);

GLuint GenFramebuffer();
void DeleteFramebuffer(GLuint framebuffer);
void BindFramebuffer(GLenum target, GLuint framebuffer);
void FramebufferTexture2D(GLenum target, GLenum attachment, GLenum textarget, GLuint texture, int level);
GLenum CheckFramebufferStatus(GLenum target);
GLuint GenRenderbuffer();
void DeleteRenderbuffer(GLuint renderbuffer);
void BindRenderbuffer(GLuint renderbuffer);
void RenderbufferStorage(GLenum format, int width, int height);
void FramebufferRenderbuffer(GLenum attachment, GLuint renderbuffer);

GLuint CreateShader(GLenum type);
void DeleteShader(GLuint shader);
void ShaderSource(GLuint shader, const std::string &source);
void CompileShader(GLuint shader);
bool GetShaderParameter(GLuint shader, GLenum pname);
std::string GetShaderInfoLog(GLuint shader);

GLuint CreateProgram();
void DeleteProgram(GLuint program);
void AttachShader(GLuint program, GLuint shader);
void BindAttribLocation(GLuint program, GLuint index, const std::string &name);
void LinkProgram(GLuint program);
bool GetProgramParameter(GLuint program, GLenum pname);
std::string GetProgramInfoLog(GLuint program);
GLint GetUniformLocation(GLuint program, const std::string &name);
GLint GetAttribLocation(GLuint program, const std::string &name);
void UseProgram(GLuint program);

void Uniform1i(GLint location, int value);
void Uniform1f(GLint location, float value);
void Uniform2f(GLint location, float x, float y);
// vec2 array upload: count is the number of floats (2 per element), matching
// glUniform2fv.  BoxBlur uses it for the eight neighbour offsets.
void Uniform2fv(GLint location, int count, const float *values);
void Uniform4f(GLint location, float x, float y, float z, float w);
void Uniform1fv(GLint location, int count, const float *values);
void UniformMatrix3fv(GLint location, const float *values);

GLuint GenBuffer();
void DeleteBuffer(GLuint buffer);
void BindBuffer(GLenum target, GLuint buffer);
void BufferData(GLenum target, uint32_t bytes, const void *data, GLenum usage);
void BufferSubData(GLenum target, int offset, uint32_t bytes, const void *data);

void EnableVertexAttribArray(GLuint index);
void VertexAttribPointer(GLuint index, int size, GLenum type, bool normalized, int stride, int offset);

void DrawElements(GLenum mode, int count, GLenum type, int offset);
void DrawArrays(GLenum mode, int first, int count);

void Viewport(int x, int y, int width, int height);
void Scissor(int x, int y, int width, int height);
void Enable(GLenum cap);
void Disable(GLenum cap);
void BlendFuncSeparate(GLenum srcRGB, GLenum dstRGB, GLenum srcAlpha, GLenum dstAlpha);
void BlendEquationSeparate(GLenum modeRGB, GLenum modeAlpha);
void BlendColor(float r, float g, float b, float a);
void ColorMask(bool r, bool g, bool b, bool a);
void ClearColor(float r, float g, float b, float a);
void Clear(GLenum mask);
void StencilMask(uint32_t mask);
void ClearStencil(int value);
void StencilOp(GLenum fail, GLenum depthFail, GLenum depthPass);
void StencilFunc(GLenum func, int ref, uint32_t mask);
void DepthMask(bool enabled);
void PixelStorei(GLenum pname, int param);
void ReadPixels(int x, int y, int width, int height, void *pixels);
void ReadCanvasPixels(int x, int y, int width, int height, void *pixels);
GLenum GetError();
int GetParameteri(GLenum pname);
void Finish();

// State cache. This is the sole owner of GL state; callers express intent only.
struct StateCache {
    GLuint program = 0;
    GLuint texture = 0;
    GLuint framebuffer = 0;
    int activeUnit = 0;
    bool blend = false;
    bool scissor = false;
    bool depth = false;
    bool cull = false;
    GLenum equationRGB = kFuncAdd, equationA = kFuncAdd;
    GLenum srcRGB = kOne, dstRGB = kZero, srcA = kOne, dstA = kZero;
    int viewport[4] = {0, 0, 0, 0};
    int scissorRect[4] = {0, 0, 0, 0};
    bool colorMask[4] = {true, true, true, true};
    float clearColor[4] = {0.f, 0.f, 0.f, 0.f};
    bool valid = false;
    void Reset();
    void Invalidate() { valid = false; }
};

StateCache &State();

void SetBlend(bool enabled, GLenum equationRGB, GLenum equationA, GLenum srcRGB, GLenum dstRGB, GLenum srcA, GLenum dstA);
void SetViewport(int x, int y, int width, int height);
void SetScissor(bool enabled, int x, int y, int width, int height);
void SetFramebuffer(GLuint framebuffer);
void UseTexture(GLuint texture);
void UseProgramCached(GLuint program);

} // namespace gal::gles
