#include "render/gles.h"
#include <GLES3/gl3.h>
#include <emscripten/html5.h>
#include <emscripten.h>
#include <vector>
#include <algorithm>

EM_JS_DEPS(gal_canvas_deps, "$GL");
EM_JS(int, gal_create_canvas_context, (), {
    return GL.createContext(Module['getRenderCanvas'](), { majorVersion: 2, minorVersion: 0 });
});
EM_JS(void, gal_resize_canvas, (int width, int height), {
    const canvas = GL.currentContext.GLctx.canvas;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
});

namespace gal::gles {
namespace { EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = 0; }
void StateCache::Reset() {
    *this = StateCache{};
    valid = true;
}
StateCache &State() { static StateCache cache; return cache; }
bool ContextCreate(int width, int height) {
    if (!context) {
        context = gal_create_canvas_context();
        if (!context) return false;
    }
    if (emscripten_webgl_make_context_current(context) != EMSCRIPTEN_RESULT_SUCCESS) return false;
    ContextResize(width, height);
    return true;
}
void ContextResize(int width, int height) {
    gal_resize_canvas(width, height);
    State().Invalidate();
}
bool ContextLost() { return !context || emscripten_is_webgl_context_lost(context); }
void NotifyContextLost() { State().Invalidate(); }
void NotifyContextRestored() { State().Invalidate(); }
int MaxTextureSize() { return GetParameteri(GL_MAX_TEXTURE_SIZE); }
int MaxRenderbufferSize() { return GetParameteri(GL_MAX_RENDERBUFFER_SIZE); }
GLuint GenTexture() { GLuint id; glGenTextures(1, &id); return id; }
void DeleteTexture(GLuint id) { if (State().texture == id) State().texture = 0; glDeleteTextures(1, &id); }
void BindTexture(GLenum target, GLuint id) { glBindTexture(target,id); }
void ActiveTexture(int unit) { auto &s=State(); if(s.activeUnit==unit) return; glActiveTexture(GL_TEXTURE0+unit); s.activeUnit=unit; s.texture=~GLuint(0); }
void TexParameteri(GLenum a, GLenum b, GLint c) { glTexParameteri(a,b,c); }
void TexImage2D(int w,int h,const void *p) { glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,w,h,0,GL_RGBA,GL_UNSIGNED_BYTE,p); }
void TexSubImage2D(int x,int y,int w,int h,const void *p) { glTexSubImage2D(GL_TEXTURE_2D,0,x,y,w,h,GL_RGBA,GL_UNSIGNED_BYTE,p); }
GLuint GenFramebuffer() { GLuint id; glGenFramebuffers(1,&id); return id; }
void DeleteFramebuffer(GLuint id) { glDeleteFramebuffers(1,&id); }
void BindFramebuffer(GLenum t,GLuint id) { glBindFramebuffer(t,id); }
void FramebufferTexture2D(GLenum t,GLenum a,GLenum tt,GLuint id,int l) { glFramebufferTexture2D(t,a,tt,id,l); }
GLenum CheckFramebufferStatus(GLenum t) { return glCheckFramebufferStatus(t); }
GLuint GenRenderbuffer() { GLuint id; glGenRenderbuffers(1,&id); return id; }
void DeleteRenderbuffer(GLuint id) { glDeleteRenderbuffers(1,&id); }
void BindRenderbuffer(GLuint id) { glBindRenderbuffer(GL_RENDERBUFFER,id); }
void RenderbufferStorage(GLenum f,int w,int h) { glRenderbufferStorage(GL_RENDERBUFFER,f,w,h); }
void FramebufferRenderbuffer(GLenum a,GLuint id) { glFramebufferRenderbuffer(GL_FRAMEBUFFER,a,GL_RENDERBUFFER,id); }
GLuint CreateShader(GLenum t) { return glCreateShader(t); }
void DeleteShader(GLuint id) { glDeleteShader(id); }
void ShaderSource(GLuint id,const std::string &s) { const char *p=s.c_str(); glShaderSource(id,1,&p,nullptr); }
void CompileShader(GLuint id) { glCompileShader(id); }
bool GetShaderParameter(GLuint id, GLenum p) { GLint v=0; glGetShaderiv(id,p,&v); return v!=0; }
std::string GetShaderInfoLog(GLuint id) { GLint n=0; glGetShaderiv(id,GL_INFO_LOG_LENGTH,&n); if(n<=1) return {}; std::string s(n,'\0'); GLsizei len=0; glGetShaderInfoLog(id,n,&len,s.data()); s.resize(len); return s; }
GLuint CreateProgram() { return glCreateProgram(); }
void DeleteProgram(GLuint id) { glDeleteProgram(id); }
void AttachShader(GLuint p,GLuint s) { glAttachShader(p,s); }
void BindAttribLocation(GLuint p,GLuint i,const std::string &n) { glBindAttribLocation(p,i,n.c_str()); }
void LinkProgram(GLuint p) { glLinkProgram(p); }
bool GetProgramParameter(GLuint id,GLenum p) { GLint v=0; glGetProgramiv(id,p,&v); return v!=0; }
std::string GetProgramInfoLog(GLuint id) { GLint n=0; glGetProgramiv(id,GL_INFO_LOG_LENGTH,&n); if(n<=1) return {}; std::string s(n,'\0'); GLsizei len=0; glGetProgramInfoLog(id,n,&len,s.data()); s.resize(len); return s; }
GLint GetUniformLocation(GLuint p,const std::string &n) { return glGetUniformLocation(p,n.c_str()); }
GLint GetAttribLocation(GLuint p,const std::string &n) { return glGetAttribLocation(p,n.c_str()); }
void UseProgram(GLuint p) { glUseProgram(p); }
void Uniform1i(GLint l,int v) { glUniform1i(l,v); }
void Uniform1f(GLint l,float v) { glUniform1f(l,v); }
void Uniform2f(GLint l,float x,float y) { glUniform2f(l,x,y); }
void Uniform2fv(GLint l,int n,const float *v) { glUniform2fv(l,n/2,v); }
void Uniform4f(GLint l,float x,float y,float z,float w) { glUniform4f(l,x,y,z,w); }
void Uniform1fv(GLint l,int n,const float *v) { glUniform1fv(l,n,v); }
void UniformMatrix3fv(GLint l,const float *v) { glUniformMatrix3fv(l,1,GL_FALSE,v); }
GLuint GenBuffer() { GLuint id; glGenBuffers(1,&id); return id; }
void DeleteBuffer(GLuint id) { glDeleteBuffers(1,&id); }
void BindBuffer(GLenum t,GLuint id) { glBindBuffer(t,id); }
void BufferData(GLenum t,uint32_t n,const void *p,GLenum u) { glBufferData(t,n,p,u); }
void BufferSubData(GLenum t,int o,uint32_t n,const void *p) { glBufferSubData(t,o,n,p); }
void EnableVertexAttribArray(GLuint i) { glEnableVertexAttribArray(i); }
void VertexAttribPointer(GLuint i,int n,GLenum t,bool norm,int stride,int offset) { glVertexAttribPointer(i,n,t,norm,stride,reinterpret_cast<const void *>(static_cast<uintptr_t>(offset))); }
void DrawElements(GLenum m,int n,GLenum t,int offset) { glDrawElements(m,n,t,reinterpret_cast<const void *>(static_cast<uintptr_t>(offset))); }
void DrawArrays(GLenum m,int start,int n) { glDrawArrays(m,start,n); }
void Viewport(int x,int y,int w,int h) { glViewport(x,y,w,h); }
void Scissor(int x,int y,int w,int h) { glScissor(x,y,w,h); }
void Enable(GLenum c) { glEnable(c); }
void Disable(GLenum c) { glDisable(c); }
void BlendFuncSeparate(GLenum a,GLenum b,GLenum c,GLenum d) { glBlendFuncSeparate(a,b,c,d); }
void BlendEquationSeparate(GLenum a,GLenum b) { glBlendEquationSeparate(a,b); }
void BlendColor(float r,float g,float b,float a) { glBlendColor(r,g,b,a); }
void ColorMask(bool r,bool g,bool b,bool a) { glColorMask(r,g,b,a); }
void ClearColor(float r,float g,float b,float a) { glClearColor(r,g,b,a); }
void Clear(GLenum m) { glClear(m); }
void StencilMask(uint32_t m) { glStencilMask(m); }
void ClearStencil(int v) { glClearStencil(v); }
void StencilOp(GLenum a,GLenum b,GLenum c) { glStencilOp(a,b,c); }
void StencilFunc(GLenum f,int r,uint32_t m) { glStencilFunc(f,r,m); }
void DepthMask(bool b) { glDepthMask(b); }
void PixelStorei(GLenum p,int v) { glPixelStorei(p,v); }
void ReadPixels(int x,int y,int w,int h,void *p) { glReadPixels(x,y,w,h,GL_RGBA,GL_UNSIGNED_BYTE,p); }
void ReadCanvasPixels(int x,int y,int w,int h,void *p) {
    auto *dst=static_cast<unsigned char *>(p); const size_t pitch=size_t(w)*4;
    std::vector<unsigned char> pixels(pitch*h); ReadPixels(x,y,w,h,pixels.data());
    for(int row=0;row<h;++row) std::copy_n(pixels.data()+size_t(h-1-row)*pitch,pitch,dst+size_t(row)*pitch);
}
GLenum GetError() { return glGetError(); }
int GetParameteri(GLenum p) { GLint v=0; glGetIntegerv(p,&v); return v; }
void Finish() { glFinish(); }

// ---- State cache ----
void SetBlend(bool enabled, GLenum equationRGB, GLenum equationA, GLenum srcRGB_, GLenum dstRGB_, GLenum srcA_, GLenum dstA_) {
    StateCache &s = State();
    if (s.blend != enabled) {
        enabled ? Enable(kBlend) : Disable(kBlend);
        s.blend = enabled;
    }
    if (!enabled) return;
    if (s.equationRGB != equationRGB || s.equationA != equationA) {
        BlendEquationSeparate(equationRGB, equationA);
        s.equationRGB = equationRGB;
        s.equationA = equationA;
    }
    if (s.srcRGB != srcRGB_ || s.dstRGB != dstRGB_ || s.srcA != srcA_ || s.dstA != dstA_) {
        BlendFuncSeparate(srcRGB_, dstRGB_, srcA_, dstA_);
        s.srcRGB = srcRGB_; s.dstRGB = dstRGB_; s.srcA = srcA_; s.dstA = dstA_;
    }
}

void SetViewport(int x, int y, int width, int height) {
    StateCache &s = State();
    if (s.viewport[0] == x && s.viewport[1] == y && s.viewport[2] == width && s.viewport[3] == height) return;
    Viewport(x, y, width, height);
    s.viewport[0] = x; s.viewport[1] = y; s.viewport[2] = width; s.viewport[3] = height;
}

void SetScissor(bool enabled, int x, int y, int width, int height) {
    StateCache &s = State();
    if (s.scissor != enabled) {
        enabled ? Enable(kScissorTest) : Disable(kScissorTest);
        s.scissor = enabled;
    }
    if (!enabled) return;
    if (s.scissorRect[0] == x && s.scissorRect[1] == y && s.scissorRect[2] == width && s.scissorRect[3] == height) return;
    Scissor(x, y, width, height);
    s.scissorRect[0] = x; s.scissorRect[1] = y; s.scissorRect[2] = width; s.scissorRect[3] = height;
}

void SetFramebuffer(GLuint framebuffer) {
    StateCache &s = State();
    if (s.framebuffer == framebuffer && s.valid) return;
    BindFramebuffer(kFramebuffer, framebuffer);
    s.framebuffer = framebuffer;
}

void UseTexture(GLuint texture) {
    StateCache &s = State();
    if (s.texture == texture) return;
    BindTexture(kTexture2D, texture);
    s.texture = texture;
}

void UseProgramCached(GLuint program) {
    StateCache &s = State();
    if (s.program == program) return;
    UseProgram(program);
    s.program = program;
}

} // namespace gal::gles
