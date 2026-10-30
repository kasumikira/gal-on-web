#pragma once
#include "RenderManager.h"
#include "render/render.h"
#include <map>
#include <memory>

class tTVPGLESRenderMethod final : public iTVPRenderMethod {
public:
    explicit tTVPGLESRenderMethod(const char *name) {
        Name = name;
        BoxBlur = Name == "BoxBlur" || Name == "BoxBlurAlpha";
    }
    gal::render::Method *Program();
    int EnumParameterID(const char *name) override;
    void SetParameterOpa(int id, int value) override;
    void SetParameterColor4B(int id, unsigned value) override;
    void SetParameterFloat(int id, float value) override;
    void SetParameterInt(int id, int value) override;
    void SetParameterUInt(int id, unsigned value) override;
    void SetParameterPtr(int id, const void *value) override;
    void SetParameterFloatArray(int id, float *value, int count) override;
    iTVPRenderMethod *SetBlendFuncSeparate(int func, int srcRGB, int dstRGB, int srcAlpha, int dstAlpha) override;
    bool IsBlendTarget() override;
    void Apply();
    // BoxBlur/BoxBlurAlpha: upload the eight neighbour UV offsets derived from
    // the area_left/top/right/bottom parameters and the source texture size.
    bool IsBoxBlur() const { return BoxBlur; }
    void ApplyBoxBlur(const iTVPTexture2D &source);
    int Opacity = 255;
    uint32_t Color = 0;
    int TransitionVague = 0;
private:
    enum {
        AreaLeft = 1,
        AreaTop,
        AreaRight,
        AreaBottom,
    };
    struct Parameter {
        std::string Name;
        bool Integer = false;
        std::vector<float> Values;
        int IntegerValue = 0;
        uint32_t Program = 0;
        int Location = -1;
    };
    std::vector<Parameter> Parameters;
    bool BoxBlur = false;
    int BlurLeft = 0, BlurTop = 0, BlurRight = 0, BlurBottom = 0;
    int BlurSampleLocation = -2;
};

class tTVPGLESRenderManager final : public iTVPRenderManager {
public:
    iTVPTexture2D *CreateTexture2D(const void *, int, unsigned, unsigned,
                                 TVPTextureFormat::e, int) override;
    iTVPTexture2D *CreateTexture2D(tTVPBitmap *) override;
    iTVPTexture2D *CreateTexture2D(TJS::tTJSBinaryStream *) override;
    iTVPTexture2D *CreateTexture2D(unsigned, unsigned, iTVPTexture2D *) override;
    iTVPRenderMethod *GetRenderMethod(const char *, uint32_t * = nullptr) override;
    const char *GetName() override { return "OpenGLES"; }
    bool GetRenderStat(unsigned &drawCount, uint64_t &memory) override;
    void BeginStencil(iTVPTexture2D *) override;
    void SetRenderTarget(iTVPTexture2D *) override;
    void OperateRect(iTVPRenderMethod *, iTVPTexture2D *, iTVPTexture2D *,
                     const tTVPRect &, const tRenderTexRectArray &) override;
    void OperateTriangles(iTVPRenderMethod *, int, iTVPTexture2D *, iTVPTexture2D *,
                          const tTVPRect &, const tTVPPointD *, const tRenderTexQuadArray &) override;
    void OperatePerspective(iTVPRenderMethod *, int, iTVPTexture2D *, iTVPTexture2D *,
                            const tTVPRect &, const tTVPPointD *, const tRenderTexQuadArray &) override;
private:
    std::map<std::string, std::unique_ptr<tTVPGLESRenderMethod>> Methods;
};

// Shader registration lives with the original visual module rather than in
// the low-level GLES driver. Standard bm shaders remain shared by both paths.
gal::render::Method *TVPGetVisualRenderMethod(const char *name);
