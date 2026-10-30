// Reference graphic-handler dispatch with browser storage stream commits.
#include "GraphicsLoaderIntf.h"
#include "BinaryStream.h"
#include "MsgIntf.h"
#include <memory>

void tTVPGraphicHandlerType::Load(void *format, void *target,
    tTVPGraphicSizeCallback size, tTVPGraphicScanLineCallback row,
    tTVPMetaInfoPushCallback meta, tTJSBinaryStream *stream,
    tjs_int32 key, tTVPGraphicLoadMode mode) {
    if(!LoadHandler) TVPThrowExceptionMessage(TVPUnknownGraphicFormat, TJS_W("unknown"));
    LoadHandler(format, target, size, row, meta, stream, key, mode);
}
void tTVPGraphicHandlerType::Header(tTJSBinaryStream *stream, iTJSDispatch2 **dict) {
    if(!HeaderHandler) TVPThrowExceptionMessage(TVPUnknownGraphicFormat, TJS_W("unknown"));
    HeaderHandler(FormatData, stream, dict);
}
void tTVPGraphicHandlerType::Save(const ttstr &name, const ttstr &mode,
    const iTVPBaseBitmap *image, iTJSDispatch2 *meta) {
    if(!SaveHandler) TVPThrowExceptionMessage(TVPUnknownGraphicFormat, mode);
    std::unique_ptr<tTJSBinaryStream> stream(TVPCreateStream(TVPNormalizeStorageName(name), TJS_BS_WRITE));
    SaveHandler(FormatData, stream.get(), image, mode, meta);
    TVPCommitStream(stream.get());
}
