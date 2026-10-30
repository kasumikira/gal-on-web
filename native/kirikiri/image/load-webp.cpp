// WebP platform decoder using the reference loader callback contract.
#include "GraphicsLoaderIntf.h"
#include "MsgIntf.h"
#include "tjsDictionary.h"
#include <webp/decode.h>
#include <vector>
#include <cstring>

namespace {
struct WebPInput {
    std::vector<uint8_t> bytes;
    WebPBitstreamFeatures features;
    explicit WebPInput(tTJSBinaryStream *stream) : bytes(stream->GetSize()) {
        stream->ReadBuffer(bytes.data(), bytes.size());
        if(WebPGetFeatures(bytes.data(), bytes.size(), &features) != VP8_STATUS_OK)
            TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));
    }
};
struct WebPOutput {
    WebPDecoderConfig config;
    WebPOutput() {
        if(!WebPInitDecoderConfig(&config))
            TVPThrowExceptionMessage(TJS_W("Invalid WebP decoder configuration"));
    }
    ~WebPOutput() { WebPFreeDecBuffer(&config.output); }
};
}

void TVPLoadWEBP(void *, void *target, tTVPGraphicSizeCallback size,
                 tTVPGraphicScanLineCallback row, tTVPMetaInfoPushCallback,
                 tTJSBinaryStream *stream, tjs_int, tTVPGraphicLoadMode mode) {
    if(mode == glmPalettized)
        TVPThrowExceptionMessage(TJS_W("WebP does not support palettized image"));
    WebPInput input(stream);
    WebPOutput output;
    auto &config = output.config;
    config.input = input.features;
    config.output.colorspace = mode == glmGrayscale ? MODE_YUV : MODE_RGBA;
    if(WebPDecode(input.bytes.data(), input.bytes.size(), &config) != VP8_STATUS_OK)
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));
    size(target, input.features.width, input.features.height,
         mode == glmGrayscale ? gpfLuminance : input.features.has_alpha ? gpfRGBA : gpfRGB);
    const auto *pixels = mode == glmGrayscale ? config.output.u.YUVA.y : config.output.u.RGBA.rgba;
    const auto pitch = mode == glmGrayscale ? config.output.u.YUVA.y_stride : config.output.u.RGBA.stride;
    const auto width = input.features.width * (mode == glmGrayscale ? 1 : 4);
    for(int y = 0; y < input.features.height; ++y) {
        auto *dest = row(target, y);
        if(!dest) break;
        memcpy(dest, pixels + y * pitch, width);
        row(target, -1);
    }
}

void TVPLoadHeaderWEBP(void *, tTJSBinaryStream *stream, iTJSDispatch2 **result) {
    WebPInput input(stream);
    auto *dict = TJSCreateDictionaryObject();
    tTJSVariant held(dict, dict);
    dict->Release();
    tTJSVariant value(input.features.width);
    dict->PropSet(TJS_MEMBERENSURE, TJS_W("width"), nullptr, &value, dict);
    value = input.features.height;
    dict->PropSet(TJS_MEMBERENSURE, TJS_W("height"), nullptr, &value, dict);
    value = input.features.has_alpha ? 32 : 24;
    dict->PropSet(TJS_MEMBERENSURE, TJS_W("bpp"), nullptr, &value, dict);
    *result = held.AsObject();
}
