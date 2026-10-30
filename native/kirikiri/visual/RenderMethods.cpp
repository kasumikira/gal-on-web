#include "NativeRenderManager.h"
#include "Platform.h"
#include <cstring>

using namespace gal::render;
using namespace gal::gles;

Method *TVPGetVisualRenderMethod(const char *name) {
    auto &device = Device::Get();
    if (auto *method = device.FindMethod(name)) return method;
    if (!std::strcmp(name, "AdjustGamma") || !std::strcmp(name, "AdjustGamma_a")) {
        const bool additive = !std::strcmp(name, "AdjustGamma_a");
        auto *method = device.CompileMethod(name,
            std::string("vec4 d=texture(tex1,v_uv1);") + (additive
                ? "vec3 t=(d.rgb/(d.a+0.001)-1.0)*step(d.rgb,d.aaa+0.001)+1.0;"
                  "t=clamp(pow(t,u_gamma.rgb)*u_amp.rgb+u_floor.rgb,0.0,1.0);"
                  "d.rgb=t*d.a+clamp(d.rgb-d.a,0.0,1.0);"
                : "d.rgb=clamp(pow(d.rgb,u_gamma.rgb)*u_amp.rgb+u_floor.rgb,0.0,1.0);")
                + "fragColor=d;", true,
            "uniform vec4 u_gamma; uniform vec4 u_floor; uniform vec4 u_amp;\n");
        if (!method) TVPThrowExceptionMessage(ttstr(device.LastError()).c_str());
        return method;
    }
    if (!std::strcmp(name, "BoxBlur") || !std::strcmp(name, "BoxBlurAlpha")) {
        // Reference RenderManager_ogl registers both names with the same
        // nine-tap shader.  The eight neighbour offsets arrive through the
        // u_sample vec2 array; the adapter derives them from the area
        // parameters at draw time (see tTVPGLESRenderMethod::ApplyBoxBlur).
        auto *method = device.CompileMethod(name,
            "s += texture(tex0, v_uv + u_sample[0]);\n"
            "s += texture(tex0, v_uv + u_sample[1]);\n"
            "s += texture(tex0, v_uv + u_sample[2]);\n"
            "s += texture(tex0, v_uv + u_sample[3]);\n"
            "s += texture(tex0, v_uv + u_sample[4]);\n"
            "s += texture(tex0, v_uv + u_sample[5]);\n"
            "s += texture(tex0, v_uv + u_sample[6]);\n"
            "s += texture(tex0, v_uv + u_sample[7]);\n"
            "fragColor = s / vec4(9.0);",
            false, "uniform vec2 u_sample[8];\n", 1);
        if (!method) TVPThrowExceptionMessage(ttstr(device.LastError()).c_str());
        method->blend = false;
        return method;
    }
    if (!std::strcmp(name, "PerspectiveAlphaBlend_a")) {
        auto *method = device.CompileMethod(name,
            "s.a *= opacity; fragColor = s;", false, {}, 1, true);
        if (!method) TVPThrowExceptionMessage(ttstr(device.LastError()).c_str());
        method->blend = true;
        method->equationRGB = kFuncAdd;
        method->equationA = kFuncAdd;
        method->srcRGB = kSrcAlpha;
        method->dstRGB = kOneMinusSrcAlpha;
        method->srcA = kOne;
        method->dstA = kOneMinusSrcAlpha;
        return method;
    }
    struct TransitionSpec { const char *name, *body; };
    const TransitionSpec transitions[] = {
        {"UnivTransBlend", "vec4 s1=texture(tex0,v_uv); vec4 s2=texture(tex1,v_uv1); vec4 rule=texture(tex2,v_uv2); float opa=clamp((rule.r-phase)/vague,0.0,1.0); s1.rgb=mix(s2.rgb,s1.rgb,opa); fragColor=s1;"},
        {"UnivTransBlend_d", "vec4 s1=texture(tex0,v_uv); vec4 s2=texture(tex1,v_uv1); vec4 rule=texture(tex2,v_uv2); float opa=clamp((rule.r-phase)/vague,0.0,1.0); s1.rgb=mix(s1.rgb,s2.rgb,s2.a*(1.0-opa)/(s2.a*(1.0-opa)*(1.0-s1.a*opa)+s1.a*opa+0.0001)); s1.a=mix(s2.a,s1.a,opa); fragColor=s1;"},
        {"UnivTransBlend_a", "vec4 s1=texture(tex0,v_uv); vec4 s2=texture(tex1,v_uv1); vec4 rule=texture(tex2,v_uv2); float opa=clamp((rule.r-phase)/vague,0.0,1.0); fragColor=mix(s2,s1,opa);"},
    };
    for (const auto &transition : transitions) {
        if (std::strcmp(transition.name, name)) continue;
        auto *method = device.CompileMethod(name, transition.body, false,
            "uniform float phase; uniform float vague;\n", 3);
        if (!method) TVPThrowExceptionMessage(ttstr(device.LastError()).c_str());
        return method;
    }
    struct Spec { const char *name, *body; bool target; GLenum srcRGB, dstRGB, srcA, dstA; bool blendColor = false; int sources = 1; };
    // Bodies and blend factors follow RenderManager_ogl registrations.
    const Spec specifications[] = {
        {"FillARGB", "fragColor = u_color;", false, kOne, kZero, kOne, kZero},
        {"FillColor", "fragColor = u_color;", false, kOne, kZero, kZero, kOne},
        {"CopyMask", "fragColor = s;", false, kZero, kOne, kOne, kZero},
        {"DoGrayScale", "vec4 d=texture(tex1,v_uv1); float c=dot(d.rgb,vec3(0.0743,0.7148,0.2109)); fragColor=vec4(vec3(c),d.a);", true, kOne, kZero, kOne, kZero},
        {"FillMask", "fragColor = vec4(0,0,0,1);", false, kZero, kOne, kConstantColor, kZero, true},
        {"ConstColorAlphaBlend", "fragColor = u_color;", false, kConstantColor, kOneMinusConstantColor, kZero, kOne, true},
        {"ConstColorAlphaBlend_a", "fragColor = vec4(u_color.rgb,1);", false, kConstantColor, kOneMinusConstantColor, kConstantColor, kOneMinusConstantColor, true},
        {"ConstColorAlphaBlend_d", "vec4 d = texture(tex1,v_uv1); d.a = opacity+d.a-opacity*d.a; d.rgb=mix(d.rgb,u_color.rgb,opacity/(d.a+0.0001)); fragColor=d;", true, kOne, kZero, kOne, kZero},
        {"ApplyColorMap", "fragColor=vec4(u_color.rgb,s.r*opacity);", false, kSrcAlpha, kOneMinusSrcAlpha, kZero, kOne},
        {"ApplyColorMap_d", "vec4 d=texture(tex1,v_uv1); s.r*=opacity; d.a=s.r+d.a-s.r*d.a; d.rgb=mix(d.rgb,u_color.rgb,s.r/(d.a+0.0001)); fragColor=d;", true, kOne, kZero, kOne, kZero},
        {"ApplyColorMap_a", "fragColor=vec4(u_color.rgb,s.r*opacity);", false, kSrcAlpha, kOneMinusSrcAlpha, kOne, kOneMinusSrcAlpha},
        {"RemoveOpacity", "fragColor=vec4(0,0,0,s.r*opacity);", false, kZero, kOne, kZero, kOneMinusSrcAlpha},
        {"RemoveConstOpacity", "fragColor=vec4(0,0,0,opacity);", false, kZero, kOne, kZero, kOneMinusSrcAlpha},
        {"AlphaToAdditiveAlpha", "fragColor=vec4(0);", false, kZero, kDstAlpha, kZero, kOne},
        {"AdditiveAlphaToAlpha", "vec4 d=texture(tex1,v_uv1); fragColor=vec4(d.a>0.0?d.rgb/d.a:vec3(0),d.a);", true, kOne, kZero, kOne, kZero},
        {"ConstAlphaBlend_SD", "vec4 d=texture(tex1,v_uv1); fragColor=mix(s,d,opacity);", false, kOne, kZero, kOne, kZero, false, 2},
        {"ConstAlphaBlend_SD_a", "vec4 d=texture(tex1,v_uv1); fragColor=mix(s,d,opacity);", false, kOne, kZero, kOne, kZero, false, 2},
        {"ConstAlphaBlend_SD_d", "vec4 d=texture(tex1,v_uv1); s.rgb=mix(s.rgb,d.rgb,d.a*opacity/(s.a*(1.0-opacity)*(1.0-d.a*opacity)+d.a*opacity+0.0001)); s.a=mix(s.a,d.a,opacity); fragColor=s;", false, kOne, kZero, kOne, kZero, false, 2},
    };
    for (const auto &spec : specifications) {
        if (std::strcmp(spec.name, name)) continue;
        auto *method = device.CompileMethod(name, spec.body, spec.target, {}, spec.sources + (spec.target ? 1 : 0));
        if (!method) TVPThrowExceptionMessage(ttstr(device.LastError()).c_str());
        method->blend = !spec.target;
        method->srcRGB = spec.srcRGB; method->dstRGB = spec.dstRGB;
        method->srcA = spec.srcA; method->dstA = spec.dstA;
        method->useBlendColor = spec.blendColor;
        return method;
    }
    TVPThrowExceptionMessage(TJS_W("Unknown native render method: %1"), ttstr(name));
}
