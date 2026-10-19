#include "runtime.h"
#include "ScriptMgnIntf.h"
#include "MemoryOutput.h"
#include <algorithm>
#include <cstring>
#include <memory>
#include <emscripten/emscripten.h>

class TextReadStream : public iTJSTextReadStream
{
    std::u16string text;
    size_t position = 0;

public:
    explicit TextReadStream(const ttstr &value) : text(value.c_str(), value.GetLen()) {}
    tjs_uint Read(ttstr &target, tjs_uint size) override
    {
        const auto count = size ? std::min<size_t>(size, text.size() - position) : text.size() - position;
        target = ttstr(text.data() + position, count);
        position += count;
        return count;
    }
    void Destruct() override { delete this; }
};
static iTJSTextReadStream *readText(const ttstr &name, const ttstr &mode)
{
    if (!activeRuntime || !activeRuntime->storage)
        throw eTJSError(TJS_W("TJS text storage is not attached"));
    tTJSVariant filename(name), options(mode), result;
    tTJSVariant *args[] = {&filename, &options};
    invoke(activeRuntime, activeRuntime->storage, 5, nullptr, &result, 2, args);
    return new TextReadStream(ttstr(result));
}
class TextWriteStream : public iTJSTextWriteStream
{
    Runtime *runtime;
    ttstr name, mode;
    std::u16string text;

public:
    TextWriteStream(Runtime *runtime, const ttstr &name, const ttstr &mode)
        : runtime(runtime), name(name), mode(mode) {}
    void Write(const ttstr &value) override
    {
        if (!value.GetLen() || !value.c_str()[0])
            return;
        for (tjs_int i = 0; i < value.GetLen(); i++)
            text.push_back(value.c_str()[i] ? value.c_str()[i] : u' ');
    }
    void Destruct() override
    {
        std::unique_ptr<TextWriteStream> self(this);
        tTJSVariant filename(name), content(ttstr(text.data(), text.size())), options(mode);
        tTJSVariant *args[] = {&filename, &content, &options};
        invoke(runtime, runtime->storage, 11, nullptr, nullptr, 3, args);
    }
};
void TVPRegisterKAGParser(iTJSDispatch2 *owner)
{
    activeRuntime->attachOwner(owner);
}
void TVPUnregisterKAGParser(iTJSDispatch2 *owner)
{
    activeRuntime->forgetOwner(owner);
}
static tTVPCompactEventCallbackIntf *compactCallback = nullptr;
void TVPAddCompactEventHook(tTVPCompactEventCallbackIntf *callback)
{
    compactCallback = callback;
}
iTJSTextReadStream *TVPCreateTextStreamForRead(const ttstr &name, const ttstr &mode)
{
    return readText(name, mode);
}
void TVPExecuteExpression(const ttstr &expression, iTJSDispatch2 *context, tTJSVariant *result)
{
    activeRuntime->engine->EvalExpression(expression, result, context);
}
void TVPAddLog(const ttstr &text)
{
    activeRuntime->Print(text.c_str());
}
ttstr TVPExtractStorageName(const ttstr &name)
{
    auto text = name.AsStdString();
    auto position = text.find_last_of("/\\>");
    return ttstr(text.substr(position == std::string::npos ? 0 : position + 1).c_str());
}
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message)
{
    throw eTJSError(message);
}
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a)
{
    ttstr text(message);
    text.Replace(TJS_W("%1"), a.c_str());
    throw eTJSError(text);
}
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a, const ttstr &b)
{
    ttstr text(message);
    text.Replace(TJS_W("%1"), a.c_str());
    text.Replace(TJS_W("%2"), b.c_str());
    throw eTJSError(text);
}
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a, tjs_int b)
{
    TVPThrowExceptionMessage(message, a, ttstr(b));
}

class MemoryInput : public tTJSBinaryStream
{
    std::vector<unsigned char> storage;
    const unsigned char *data;
    size_t size, position = 0;

public:
    MemoryInput(const unsigned char *data, size_t size) : data(data), size(size) {}
    explicit MemoryInput(std::vector<unsigned char> bytes) : storage(std::move(bytes)), data(storage.data()), size(storage.size()) {}
    tjs_uint64 Seek(tjs_int64 offset, tjs_int whence) override
    {
        const auto next = (whence == TJS_BS_SEEK_SET ? 0 : whence == TJS_BS_SEEK_CUR ? position
                                                                                     : size) +
                          offset;
        if (next > size)
            throw eTJSError(TJS_W("TJS stream seek outside input"));
        position = next;
        return position;
    }
    tjs_uint Read(void *buffer, tjs_uint length) override
    {
        const auto count = std::min<size_t>(length, size - position);
        std::memcpy(buffer, data + position, count);
        position += count;
        return count;
    }
    tjs_uint Write(const void *, tjs_uint) override { throw eTJSError(TJS_W("TJS input stream is read-only")); }
    tjs_uint64 GetSize() override { return size; }
};
static tTJSBinaryStream *readBinary(const ttstr &name, const ttstr &mode)
{
    if (!activeRuntime || !activeRuntime->storage)
        throw eTJSError(TJS_W("TJS binary storage is not attached"));
    tTJSVariant filename(name), options(mode), result;
    tTJSVariant *args[] = {&filename, &options};
    invoke(activeRuntime, activeRuntime->storage, 6, nullptr, &result, 2, args);
    const auto *bytes = result.AsOctetNoAddRef();
    return new MemoryInput(std::vector<unsigned char>(bytes->GetData(), bytes->GetData() + bytes->GetLength()));
}

tTJS *TVPGetScriptEngine()
{
    return activeRuntime->engine;
}
void TVPExecuteExpression(const ttstr &content, const ttstr &name, int offset, iTJSDispatch2 *context,
                          tTJSVariant *result)
{
    activeRuntime->engine->EvalExpression(content, result, context, &name, offset);
}
void TVPDumpScriptEngine()
{
    activeRuntime->engine->Dump();
}
const tjs_char *TVPGetDefaultReadEncoding()
{
    tTJSVariant result;
    invoke(activeRuntime, activeRuntime->storage, 7, nullptr, &result, 0, nullptr);
    activeRuntime->text = ttstr(result).c_str();
    return activeRuntime->text.c_str();
}
void TVPSetDefaultReadEncoding(const ttstr &encoding)
{
    tTJSVariant value(encoding);
    tTJSVariant *args[] = {&value};
    invoke(activeRuntime, activeRuntime->storage, 8, nullptr, nullptr, 1, args);
}
static ttstr placedPath(const ttstr &name)
{
    tTJSVariant value(name), result;
    tTJSVariant *args[] = {&value};
    invoke(activeRuntime, activeRuntime->storage, 9, nullptr, &result, 1, args);
    return ttstr(result);
}
void TVPExecuteStorage(const ttstr &name, iTJSDispatch2 *context, tTJSVariant *result, bool expression,
                       const tjs_char *mode)
{
    const ttstr place = placedPath(name), shortname = TVPExtractStorageName(place);
    std::unique_ptr<tTJSBinaryStream> binary(readBinary(place, mode));
    if (activeRuntime->engine->LoadByteCode(binary.get(), result, context, shortname.c_str()))
        return;
    auto *stream = readText(place, mode);
    ttstr content;
    try
    {
        stream->Read(content, 0);
    }
    catch (...)
    {
        stream->Destruct();
        throw;
    }
    stream->Destruct();
    if (expression)
        activeRuntime->engine->EvalExpression(content, result, context, &shortname);
    else
        activeRuntime->engine->ExecScript(content, result, context, &shortname);
}
void TVPCompileStorage(const ttstr &name, bool result, bool debug, bool expression, const ttstr &output)
{
    const ttstr place = placedPath(name), shortname = TVPExtractStorageName(place);
    auto *stream = readText(place, TJS_W(""));
    ttstr content;
    try
    {
        stream->Read(content, 0);
    }
    catch (...)
    {
        stream->Destruct();
        throw;
    }
    stream->Destruct();
    MemoryOutput binary;
    activeRuntime->engine->CompileScript(content.c_str(), &binary, result, debug, expression, shortname.c_str(), 0);
    tTJSVariant filename(output), bytes(binary.bytes.data(), binary.bytes.size());
    tTJSVariant *args[] = {&filename, &bytes};
    invoke(activeRuntime, activeRuntime->storage, 10, nullptr, nullptr, 2, args);
}

void initializeStorageCallbacks()
{
    TJSCreateTextStreamForRead = readText;
    TJSCreateTextStreamForWrite = [](const ttstr &name, const ttstr &mode) -> iTJSTextWriteStream *
    {
        if (!activeRuntime || !activeRuntime->storage)
            throw eTJSError(TJS_W("TJS text storage is not attached"));
        return new TextWriteStream(activeRuntime, name, mode);
    };
    TJSCreateBinaryStreamForRead = readBinary;
    TJSCreateBinaryStreamForWrite = [](const ttstr &, const ttstr &) -> tTJSBinaryStream *
    { throw eTJSError(TJS_W("TJS binary storage writing is not implemented")); };
}
void compactRuntime()
{
    if (compactCallback) compactCallback->OnCompact(TVP_COMPACT_LEVEL_DEACTIVATE);
}

extern "C"
{
    EMSCRIPTEN_KEEPALIVE int tjs_deserialize(Runtime *r, const unsigned char *data, int size)
    {
        return checked(r, [&]
                       {MemoryInput input(data,size);tTJSVariant value;if(!r->engine->LoadBinaryDictionayArray(&input,&value))throw eTJSError(TJS_W("TJS binary structure header required"));return r->keep(value); });
    }
}
