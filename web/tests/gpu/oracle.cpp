// Test-only executable: compile the reference source directly, never the JS oracle.
// No renderer or second WASM is added to the application.
#include <iostream>
#include <vector>
#include <stdexcept>
#include <cmath>
#include <algorithm>
#include "../../../third_party/kirikiroid2/cpp/core/visual/tvpgl.cpp"
#include "../../../third_party/kirikiroid2/cpp/core/visual/argb.h"

static void blend(tjs_uint32 *d, const tjs_uint32 *s, int n, int mode, int opa, int flags) {
    const bool hold = flags & 1, destinationAlpha = flags & 2, additive = flags & 4;
    // LayerBitmapIntf.cpp Blt returns before the primitive at opacity zero.
    if (opa == 0) return;
    if (flags & 16) {
        std::vector<tjs_uint32> opaque(s, s + n);
        for (auto &pixel : opaque) pixel |= 0xff000000u;
        blend(d, opaque.data(), n, mode, opa, flags & ~16);
        return;
    }
    // LayerBitmapIntf.cpp PartialBlt / TVP_BLEND_4 dispatch.
#define BLEND(name) do { \
    if (opa == 255) { if (hold) name##_HDA(d,s,n); else name(d,s,n); } \
    else { if (hold) name##_HDA_o(d,s,n,opa); else name##_o(d,s,n,opa); } \
} while (false)
    switch (mode) {
    case 0: return;
    case 1:
        if (destinationAlpha && !(flags & 8)) {
            if (opa == 255) TVPCopyOpaqueImage(d,s,n);
            else if (additive) TVPConstAlphaBlend_a(d,s,n,opa);
            else TVPConstAlphaBlend_d(d,s,n,opa);
            return;
        }
        if (opa == 255) {
            if (hold) TVPCopyColor(d,s,n);
            else if (flags & 8 || !destinationAlpha) TVPCopyMask(d,s,n), TVPCopyColor(d,s,n);
            else TVPCopyOpaqueImage(d,s,n);
        } else if (hold) TVPConstAlphaBlend_HDA(d,s,n,opa);
        else if (additive) TVPConstAlphaBlend_a(d,s,n,opa);
        else if (destinationAlpha) TVPConstAlphaBlend_d(d,s,n,opa);
        else TVPConstAlphaBlend(d,s,n,opa);
        return;
    case 2:
        if (!destinationAlpha) { BLEND(TVPAlphaBlend); }
        else if (additive) { if (opa == 255) TVPAlphaBlend_a(d,s,n); else TVPAlphaBlend_ao(d,s,n,opa); }
        else { if (opa == 255) TVPAlphaBlend_d(d,s,n); else TVPAlphaBlend_do(d,s,n,opa); }
        return;
    case 3: BLEND(TVPAddBlend); return;
    case 4: BLEND(TVPSubBlend); return;
    case 5: BLEND(TVPMulBlend); return;
    case 8: BLEND(TVPColorDodgeBlend); return;
    case 9: BLEND(TVPDarkenBlend); return;
    case 10: BLEND(TVPLightenBlend); return;
    case 11: BLEND(TVPScreenBlend); return;
    case 12:
        if (additive && !hold) { if (opa == 255) TVPAdditiveAlphaBlend_a(d,s,n); else TVPAdditiveAlphaBlend_ao(d,s,n,opa); }
        else { BLEND(TVPAdditiveAlphaBlend); }
        return;
    case 13: BLEND(TVPPsAlphaBlend); return;
    case 14: BLEND(TVPPsAddBlend); return;
    case 15: BLEND(TVPPsSubBlend); return;
    case 16: BLEND(TVPPsMulBlend); return;
    case 17: BLEND(TVPPsScreenBlend); return;
    case 18: BLEND(TVPPsOverlayBlend); return;
    case 19: BLEND(TVPPsHardLightBlend); return;
    case 20: BLEND(TVPPsSoftLightBlend); return;
    case 21: BLEND(TVPPsColorDodgeBlend); return;
    case 22: BLEND(TVPPsColorDodge5Blend); return;
    case 23: BLEND(TVPPsColorBurnBlend); return;
    case 24: BLEND(TVPPsLightenBlend); return;
    case 25: BLEND(TVPPsDarkenBlend); return;
    case 26: BLEND(TVPPsDiffBlend); return;
    case 27: BLEND(TVPPsDiff5Blend); return;
    case 28: BLEND(TVPPsExclusionBlend); return;
    default: throw std::runtime_error("unsupported reference blend mode");
    }
#undef BLEND
}

int main() {
    TVPInitTVPGL();
    int op, n, mode, opa, flags, phase, vague;
    while (std::cin >> op >> n >> mode >> opa >> flags >> phase >> vague) {
        std::vector<tjs_uint32> d(n), a(n), b(n), rule(n);
        for (auto *v : {&d, &a, &b, &rule}) for (auto &p : *v) std::cin >> p;
        switch (op) {
        case 0: blend(d.data(), a.data(), n, mode, opa, flags); break;
        case 1: TVPFillARGB(d.data(),n,a[0]); break;
        case 2: TVPFillMask(d.data(),n,a[0] >> 24); break;
        case 3: TVPCopyColor(d.data(),a.data(),n); TVPCopyMask(d.data(),a.data(),n); break;
        case 4:
            if (mode == 2 || mode >= 13) TVPConstAlphaBlend_SD_d(d.data(),a.data(),b.data(),n,phase);
            else if (mode == 12) TVPConstAlphaBlend_SD_a(d.data(),a.data(),b.data(),n,phase);
            else TVPConstAlphaBlend_SD(d.data(),a.data(),b.data(),n,phase);
            break;
        case 5: {
            tjs_uint32 table[256];
            TVPInitUnivTransBlendTable(table,phase,vague);
            std::vector<tjs_uint8> gray(n);
            for (int i=0;i<n;i++) gray[i]=(rule[i] >> 16) & 255;
#define UNIVERSAL(name) do { \
    if (vague < 512) name##_switch(d.data(),a.data(),b.data(),gray.data(),table,n,phase,phase-vague); \
    else name(d.data(),a.data(),b.data(),gray.data(),table,n); \
} while(false)
            if (mode == 2 || mode >= 13) {
                if (vague < 512) TVPUnivTransBlend_switch_d(d.data(),a.data(),b.data(),gray.data(),table,n,phase,phase-vague);
                else TVPUnivTransBlend_d(d.data(),a.data(),b.data(),gray.data(),table,n);
            } else if (mode == 12) {
                if (vague < 512) TVPUnivTransBlend_switch_a(d.data(),a.data(),b.data(),gray.data(),table,n,phase,phase-vague);
                else TVPUnivTransBlend_a(d.data(),a.data(),b.data(),gray.data(),table,n);
            } else { UNIVERSAL(TVPUnivTransBlend); }
#undef UNIVERSAL
            break;
        }
        case 6: {
            // Geometry harness: inverse-map pixel centres, then sample using
            // the reference 16.16 nearest/bilinear primitive. This tests sampling
            // and the GPU contract, not LayerBitmapImpl's full edge rasterizer.
            double m[6], r[4], clip[4];
            for (auto &v : m) std::cin >> v;
            for (auto &v : r) std::cin >> v;
            for (auto &v : clip) std::cin >> v;
            const int width = mode, height = opa;
            const double det = m[0]*m[3]-m[1]*m[2];
            if (det == 0) break;
            // Padding repeats edge pixels for the interpolation kernel's +1 read.
            std::vector<tjs_uint32> padded((width+1)*(height+1));
            for (int y=0;y<=height;y++) for (int x=0;x<=width;x++)
                padded[y*(width+1)+x]=a[std::min(y,height-1)*width+std::min(x,width-1)];
            for (int y=0;y<height;y++) for (int x=0;x<width;x++) {
                if (x<clip[0] || y<clip[1] || x>=clip[2] || y>=clip[3]) continue;
                const double dx=x+0.5-m[4], dy=y+0.5-m[5];
                double u=(m[3]*dx-m[2]*dy)/det, v=(-m[1]*dx+m[0]*dy)/det;
                if (u<r[0] || v<r[1] || u>=r[2] || v>=r[3]) continue;
                if (flags) {
                    u=std::max(r[0],std::min(r[2]-1,u-0.5));
                    v=std::max(r[1],std::min(r[3]-1,v-0.5));
                    TVPInterpLinTransCopy(&d[y*width+x],1,padded.data(),int(u*65536),int(v*65536),0,0,(width+1)*4);
                } else TVPLinTransCopy(&d[y*width+x],1,a.data(),int(u*65536),int(v*65536),0,0,width*4);
            }
            break;
        }
        case 7:
            d=a;
            TVPAlphaColorMat(d.data(),0,n);
            break;
        case 8: {
            // Ideal double precision bilinear sampling on the same inverse-mapped
            // grid. The engine's GL render backend filters textures with
            // GL_LINEAR and never reads StretchType, so this is the reference for
            // the sampling the original actually displays; the software
            // TVPInterpLinTransCopy kernel is reported separately as an archive.
            double m[6], r[4], clip[4];
            for (auto &v : m) std::cin >> v;
            for (auto &v : r) std::cin >> v;
            for (auto &v : clip) std::cin >> v;
            const int width = mode, height = opa;
            const double det = m[0]*m[3]-m[1]*m[2];
            if (det == 0) break;
            const auto channel = [&](int x, int y, int ch) -> int {
                x = std::max(0, std::min(width - 1, x));
                y = std::max(0, std::min(height - 1, y));
                return (int)((a[y*width+x] >> (8*ch)) & 0xff);
            };
            for (int y=0;y<height;y++) for (int x=0;x<width;x++) {
                if (x<clip[0] || y<clip[1] || x>=clip[2] || y>=clip[3]) continue;
                const double dx=x+0.5-m[4], dy=y+0.5-m[5];
                double u=(m[3]*dx-m[2]*dy)/det, v=(-m[1]*dx+m[0]*dy)/det;
                if (u<r[0] || v<r[1] || u>=r[2] || v>=r[3]) continue;
                // texel centres at integers, matching TVPInterpLinTransCopy's grid.
                u = std::max(r[0], std::min(r[2]-1, u-0.5));
                v = std::max(r[1], std::min(r[3]-1, v-0.5));
                const int x0 = (int)std::floor(u), y0 = (int)std::floor(v);
                const double fx = u - x0, fy = v - y0;
                tjs_uint32 out = 0;
                for (int ch = 0; ch < 4; ch++) {
                    const double top = channel(x0, y0, ch)*(1.0-fx) + channel(x0+1, y0, ch)*fx;
                    const double bottom = channel(x0, y0+1, ch)*(1.0-fx) + channel(x0+1, y0+1, ch)*fx;
                    int value = (int)std::floor(top*(1.0-fy) + bottom*fy + 0.5);
                    value = std::max(0, std::min(255, value));
                    out |= (tjs_uint32)value << (8*ch);
                }
                d[y*width+x] = out;
            }
            break;
        }
        // LayerBitmapIntf FillColor / BlendColor / RemoveConstOpacity family.
        case 9: TVPFillColor(d.data(), n, (tjs_uint32)mode); break;
        case 10: TVPConstColorAlphaBlend(d.data(), n, (tjs_uint32)mode, opa); break;
        case 11: TVPConstColorAlphaBlend_d(d.data(), n, (tjs_uint32)mode, opa); break;
        case 12: TVPConstColorAlphaBlend_a(d.data(), n, (tjs_uint32)mode, opa); break;
        case 13: TVPFillARGB(d.data(), n, (tjs_uint32)mode); break;
        case 14: TVPRemoveConstOpacity(d.data(), n, opa); break;
        // Whole image value transforms.
        case 15: TVPDoGrayScale(d.data(), n); break;
        case 16: TVPConvertAlphaToAdditiveAlpha(d.data(), n); break;
        case 17: TVPConvertAdditiveAlphaToAlpha(d.data(), n); break;
        // iTVPBaseBitmap::DoBoxBlur / DoBoxBlurForAlpha: the reference sliding
        // window is composed from the real tTVPARGB accumulators and the real
        // TVPDoBoxBlurAvg32[_d] finalizer, one pixel at a time.
        case 18:
        case 19: {
            const int size = (int)std::lround(std::sqrt((double)n));
            const int area[4] = { mode, opa, phase, vague };  // left, top, right, bottom
            const std::vector<tjs_uint32> input = d;
            for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
                int x0 = std::max(0, x + area[0]), x1 = std::min(size - 1, x + area[2]);
                int y0 = std::max(0, y + area[1]), y1 = std::min(size - 1, y + area[3]);
                if (x1 < x0 || y1 < y0) { d[y*size+x] = 0; continue; }
                const int count = (x1 - x0 + 1) * (y1 - y0 + 1);
                tjs_uint32 sum[4] = { 0, 0, 0, 0 }, zero[4] = { 0, 0, 0, 0 };
                if (op == 19) {
                    tTVPARGB_AA<tjs_uint32> acc;
                    acc.Zero();
                    for (int yy = y0; yy <= y1; yy++) for (int xx = x0; xx <= x1; xx++) acc += input[yy*size+xx];
                    sum[0] = acc.b; sum[1] = acc.g; sum[2] = acc.r; sum[3] = acc.a;
                    TVPDoBoxBlurAvg32_d(&d[y*size+x], sum, zero, zero, count, 1);
                } else {
                    tTVPARGB<tjs_uint32> acc;
                    acc.Zero();
                    for (int yy = y0; yy <= y1; yy++) for (int xx = x0; xx <= x1; xx++) acc += input[yy*size+xx];
                    sum[0] = acc.b; sum[1] = acc.g; sum[2] = acc.r; sum[3] = acc.a;
                    TVPDoBoxBlurAvg32(&d[y*size+x], sum, zero, zero, count, 1);
                }
            }
            break;
        }
        // LayerIntf AdjustGamma: TVPInitGammaAdjustTempData + TVPAdjustGamma[_a].
        case 20:
        case 21: {
            double v[9];
            for (auto &x : v) std::cin >> x;
            tTVPGLGammaAdjustData data;
            data.RGamma = v[0]; data.RFloor = v[1]; data.RCeil = v[2];
            data.GGamma = v[3]; data.GFloor = v[4]; data.GCeil = v[5];
            data.BGamma = v[6]; data.BFloor = v[7]; data.BCeil = v[8];
            tTVPGLGammaAdjustTempData temp;
            TVPInitGammaAdjustTempData(&temp, &data);
            if (op == 21) TVPAdjustGamma_a(d.data(), n, &temp);
            else TVPAdjustGamma(d.data(), n, &temp);
            TVPUninitGammaAdjustTempData(&temp);
            break;
        }
        // tTJSNI_BaseLayer::ApplyGaussianBlur (LayerIntf.cpp:5785-5945), copied
        // verbatim: generate_1d_gaussian_kernel + horizontal + vertical pass.
        case 22: {
            double sigma_in;
            std::cin >> sigma_in;
            const int size = (int)std::lround(std::sqrt((double)n));
            const int radius = mode;
            const float sigma = (float)sigma_in;
            const int ksize = 2 * radius + 1;
            std::vector<float> kernel(ksize);
            float sum = 0.0f;
            float r_squared = 2.0f * sigma * sigma;
            for (int i = 0; i < ksize; ++i) {
                int x = i - radius;
                kernel[i] = exp(-(static_cast<float>(x * x)) / r_squared);
                sum += kernel[i];
            }
            for (int i = 0; i < ksize; ++i) kernel[i] /= sum;
            const auto clampByte = [](float v) { return (tjs_uint8)std::min(255.0f, std::max(0.0f, v)); };
            const std::vector<tjs_uint32> original = d;
            std::vector<tjs_uint32> temp(n);
            for (int y = 0; y < size; ++y) for (int x = 0; x < size; ++x) {
                float sr = 0.0f, sg = 0.0f, sb = 0.0f, sa = 0.0f;
                for (int k = -radius; k <= radius; ++k) {
                    int sample_x = std::max(0, std::min(x + k, size - 1));
                    tjs_uint32 c = original[y * size + sample_x];
                    float weight = kernel[k + radius];
                    sa += ((c >> 24) & 0xFF) * weight;
                    sr += ((c >> 16) & 0xFF) * weight;
                    sg += ((c >> 8) & 0xFF) * weight;
                    sb += (c & 0xFF) * weight;
                }
                temp[y * size + x] = (tjs_uint32)clampByte(sa) << 24 | (tjs_uint32)clampByte(sr) << 16 |
                                     (tjs_uint32)clampByte(sg) << 8 | (tjs_uint32)clampByte(sb);
            }
            for (int y = 0; y < size; ++y) for (int x = 0; x < size; ++x) {
                float sr = 0.0f, sg = 0.0f, sb = 0.0f, sa = 0.0f;
                for (int k = -radius; k <= radius; ++k) {
                    int sample_y = std::max(0, std::min(y + k, size - 1));
                    tjs_uint32 c = temp[sample_y * size + x];
                    float weight = kernel[k + radius];
                    sa += ((c >> 24) & 0xFF) * weight;
                    sr += ((c >> 16) & 0xFF) * weight;
                    sg += ((c >> 8) & 0xFF) * weight;
                    sb += (c & 0xFF) * weight;
                }
                d[y * size + x] = (tjs_uint32)clampByte(sa) << 24 | (tjs_uint32)clampByte(sr) << 16 |
                                  (tjs_uint32)clampByte(sg) << 8 | (tjs_uint32)clampByte(sb);
            }
            break;
        }
        default: throw std::runtime_error("unsupported reference operation");
        }
        for (auto p : d) std::cout << p << ' ';
        std::cout << '\n';
    }
    TVPUninitTVPGL();
}
