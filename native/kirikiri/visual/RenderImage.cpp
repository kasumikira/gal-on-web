#include "NativeRenderManager.h"
#include "image/image-loader.h"

iTVPTexture2D *tTVPGLESRenderManager::CreateTexture2D(TJS::tTJSBinaryStream *stream) {
    const auto image = gal::image::Decode(stream, 0x1fffffff, glmNormal);
    return CreateTexture2D(image.pixels.data(), image.Pitch(), image.width, image.height,
                           TVPTextureFormat::RGBA, 0);
}
