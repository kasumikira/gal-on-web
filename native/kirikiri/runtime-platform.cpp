#include "StoragesIntf.h"
#include "TextStream.h"
#include "BinaryStream.h"
#include "runtime.h"
#include "ScriptMgnIntf.h"
#include "MemoryOutput.h"
#include <algorithm>
#include <cstring>
#include <limits>
#include <memory>
#include <emscripten/emscripten.h>

static ttstr RequiredStorage(const ttstr &name) {
 const auto path = TVPNativePlacedPath(name);
 if (path.IsEmpty()) TVPThrowExceptionMessage(TJS_W("Storage not found: %1"), name);
 return path;
}

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
// core/environ/Application.cpp routes this through the locale config manager,
// whose GetText returns the message id itself for keys that have no entry. The
// runtime ships no locale table, so every lookup resolves to its own key; this
// keeps tTJSBinaryStream::ReadBuffer raising a located read error.
ttstr TVPGetMessageByLocale(const std::string &key)
{
    return ttstr(key);
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
    tTJSVariant octet;
    const unsigned char *data;
    size_t size, position = 0;

public:
    MemoryInput(const unsigned char *data, size_t size) : data(data), size(size) {}
    // Holds the host-read Octet alive directly, so the wasm heap keeps one
    // copy of every storage read instead of two.
    MemoryInput(tTJSVariant bytes, tjs_uint64 offset = 0) : octet(std::move(bytes))
    {
        const auto *held = octet.AsOctetNoAddRef();
        if (offset > held->GetLength())
            throw eTJSError(TJS_W("TJS stream seek outside input"));
        data = held->GetData() + offset;
        size = held->GetLength() - offset;
    }
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
static bool binaryWriteOffset(const ttstr &mode, tjs_uint64 &offset)
{
    const tjs_char *position = TJS_strchr(mode.c_str(), TJS_W('o'));
    if (!position)
        return false;
    position++;
    tjs_char digits[256];
    int count = 0;
    while (count < 255 && position[count] >= TJS_W('0') && position[count] <= TJS_W('9'))
    {
        digits[count] = position[count];
        count++;
    }
    digits[count] = 0;
    offset = ttstr(digits).AsInteger();
    return true;
}

static tTJSBinaryStream *readBinary(const ttstr &name, const ttstr &mode)
{
    if (!activeRuntime || !activeRuntime->storage)
        throw eTJSError(TJS_W("TJS binary storage is not attached"));
    tTJSVariant filename(RequiredStorage(name)), options(mode), result;
    tTJSVariant *args[] = {&filename, &options};
    invoke(activeRuntime, activeRuntime->storage, 6, nullptr, &result, 2, args);
    tjs_uint64 offset = 0;
    binaryWriteOffset(mode, offset);
    return new MemoryInput(std::move(result), offset);
}

class BinaryWriteStream final : public tTJSBinaryStream
{
    Runtime *runtime;
    ttstr name;
    MemoryOutput output;
    bool commitOnDestruction;

    void commit()
    {
        if (!runtime || !runtime->storage)
            throw eTJSError(TJS_W("TJS binary storage is not attached"));
        tTJSVariant filename(name), content(output.bytes.data(), output.bytes.size());
        tTJSVariant *args[] = {&filename, &content};
        invoke(runtime, runtime->storage, 10, nullptr, nullptr, 2, args);
    }

public:
    BinaryWriteStream(Runtime *runtime, const ttstr &name, const ttstr &mode, bool commitOnDestruction = true)
        : runtime(runtime), name(TVPNativeFullPath(name)), commitOnDestruction(commitOnDestruction)
    {
        tjs_uint64 offset;
        if (!binaryWriteOffset(mode, offset))
            return;

        std::unique_ptr<tTJSBinaryStream> input(readBinary(name, ttstr()));
        const auto size = input->GetSize();
        if (size > output.bytes.max_size())
            throw eTJSError(TJS_W("TJS binary storage is too large"));
        output.bytes.resize(static_cast<size_t>(size));
        size_t read = 0;
        while (read < output.bytes.size())
        {
            const auto length = static_cast<tjs_uint>(std::min<size_t>(
                output.bytes.size() - read, std::numeric_limits<tjs_uint>::max()));
            const auto count = input->Read(output.bytes.data() + read, length);
            if (!count)
                throw eTJSError(TJS_W("TJS binary storage read was truncated"));
            read += count;
        }
        if (offset > output.bytes.max_size())
            throw eTJSError(TJS_W("TJS binary storage seek outside output"));
        output.Seek(static_cast<tjs_int64>(offset), TJS_BS_SEEK_SET);
    }

    void Commit() { commit(); }

    ~BinaryWriteStream() override
    {
        if (!commitOnDestruction) return;
        try
        {
            commit();
        }
        catch (...)
        {
            // The base stream destructor is noexcept, so close-time storage
            // errors cannot be propagated through the original saveStruct API.
        }
    }

    tjs_uint64 Seek(tjs_int64 offset, tjs_int whence) override
    {
        return output.Seek(offset, whence);
    }

    tjs_uint Read(void *buffer, tjs_uint length) override
    {
        const auto count = static_cast<tjs_uint>(std::min<size_t>(length,
            output.position < output.bytes.size() ? output.bytes.size() - output.position : 0));
        if (count) std::memcpy(buffer, output.bytes.data() + output.position, count);
        output.position += count;
        return count;
    }

    tjs_uint Write(const void *buffer, tjs_uint length) override
    {
        return output.Write(buffer, length);
    }

    void SetEndOfStorage() override
    {
        output.SetEndOfStorage();
    }

    tjs_uint64 GetSize() override
    {
        return output.GetSize();
    }

};

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
tTJSBinaryStream *TVPCreateStream(const ttstr &name, tjs_uint32 flags) {
    switch (flags & TJS_BS_ACCESS_MASK) {
        case TJS_BS_READ: return readBinary(name, ttstr());
        case TJS_BS_WRITE: return new BinaryWriteStream(activeRuntime, name, ttstr(), false);
        case TJS_BS_UPDATE: return new BinaryWriteStream(activeRuntime, name, TJS_W("o0"), false);
        default: TVPThrowExceptionMessage(TJS_W("Unsupported binary stream access mode"));
    }
}
void TVPCommitStream(tTJSBinaryStream *stream) {
    // Text writers receive only BinaryWriteStream from TVPCreateStream.
    static_cast<BinaryWriteStream *>(stream)->Commit();
}
static ttstr placedPath(const ttstr &name) { return TVPNativePlacedPath(name); }

ttstr TVPGetPlacedPath(const ttstr &name) { return placedPath(name); }

void TVPExecuteStorage(const ttstr &name, iTJSDispatch2 *context, tTJSVariant *result, bool expression,
                       const tjs_char *mode)
{
    const ttstr place = placedPath(name), shortname = TVPExtractStorageName(place);
    std::unique_ptr<tTJSBinaryStream> binary(readBinary(place, mode));
    if (activeRuntime->engine->LoadByteCode(binary.get(), result, context, shortname.c_str()))
        return;
    auto *stream = TVPCreateTextStreamForRead(place, mode);
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
    auto *stream = TVPCreateTextStreamForRead(place, TJS_W(""));
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
    tTJSVariant filename(TVPNativeFullPath(output)), bytes(binary.bytes.data(), binary.bytes.size());
    tTJSVariant *args[] = {&filename, &bytes};
    invoke(activeRuntime, activeRuntime->storage, 10, nullptr, nullptr, 2, args);
}

void initializeStorageCallbacks()
{
    TJSCreateTextStreamForRead = TVPCreateTextStreamForRead;
    TJSCreateTextStreamForWrite = TVPCreateTextStreamForWrite;
    TJSCreateBinaryStreamForRead = readBinary;
    TJSCreateBinaryStreamForWrite = [](const ttstr &name, const ttstr &mode) -> tTJSBinaryStream *
    {
        if (!activeRuntime || !activeRuntime->storage)
            throw eTJSError(TJS_W("TJS binary storage is not attached"));
        return new BinaryWriteStream(activeRuntime, name, mode);
    };
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
