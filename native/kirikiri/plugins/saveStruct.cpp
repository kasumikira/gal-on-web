//---------------------------------------------------------------------------
// saveStruct native methods, adapted from cpp/plugins/saveStruct.cpp.
//
// The reference registers through ncbind (NCB_ATTACH_CLASS / NCB_POST_REGIST_CALLBACK).
// This port keeps the serializer body verbatim and registers the members directly
// on the Array and Dictionary class objects.
//
// The reference writes raw UTF-16 code units through a binary stream, with no
// text-stream BOM, so save2 keeps that framing rather than the BOM-prefixed
// buffer the JS implementation produced.
//---------------------------------------------------------------------------
#include "MemoryOutput.h"
#include "ScriptMgnIntf.h"
#include "tjsNative.h"

#include <fmt/format.h>
#include <memory>
#include <string>

#define NCB_MODULE_NAME TJS_W("saveStruct.dll")

//---------------------------------------------------------------------------

class tTVPStringStream
{
    tTJSBinaryStream *stream;
    const tjs_char *_newline;

  public:
    tTVPStringStream(tTJSBinaryStream *s, bool onlyLF = false);

    void write(tjs_char c);

    void write(const tjs_char *s);

    void write(tTVInteger var);

    void write(tTVReal var);

    void newline();
};

tTVPStringStream::tTVPStringStream(tTJSBinaryStream *s, bool onlyLF /*= false*/) : stream(s)
{
    if (onlyLF)
        _newline = TJS_W("\n");
    else
        _newline = TJS_W("\r\n");
}

void tTVPStringStream::write(tjs_char c) { stream->Write(&c, sizeof(c)); }

void tTVPStringStream::write(const tjs_char *s) { stream->Write(s, TJS_strlen(s) * sizeof(*s)); }

void tTVPStringStream::write(tTVInteger var)
{
    // tTJSString's integer constructor adopts TJSIntegerToString's result, so the
    // text matches the reference without leaking its returned reference.
    ttstr s((tjs_int64)var);
    stream->Write(s.c_str(), s.length() * sizeof(tjs_char));
}

void tTVPStringStream::write(tTVReal var)
{
    ttstr s{ tTJSVariant(var) };
    stream->Write(s.c_str(), s.length() * sizeof(tjs_char));
}

void tTVPStringStream::newline() { write(_newline); }

static void quoteString(const tjs_char *str, tTVPStringStream *writer)
{
    if (str)
    {
        writer->write((tjs_char)'"');
        const tjs_char *p = str;
        int ch;
        while ((ch = *p++))
        {
            if (ch == '"')
            {
                writer->write(TJS_W("\\\""));
            }
            else if (ch == '\\')
            {
                writer->write(TJS_W("\\\\"));
            }
            else
            {
                writer->write((tjs_char)ch);
            }
        }
        writer->write((tjs_char)'"');
    }
    else
    {
        writer->write(TJS_W("\"\""));
    }
}

static void quoteOctet(tTJSVariantOctet *octet, tTVPStringStream *writer)
{
    const tjs_uint8 *data = octet->GetData();
    tjs_uint length = octet->GetLength();
    writer->write(TJS_W("<% "));
    for (tjs_uint i = 0; i < length; i++)
    {
        writer->write(ttstr{ fmt::format("{:02x} ", data[i]) }.c_str());
    }
    writer->write(TJS_W("%>"));
}

static void getVariantString(tTJSVariant &var, tTVPStringStream *writer);

//---------------------------------------------------------------------------
// Dictionary member enumeration callback.
//---------------------------------------------------------------------------
class DictMemberDispCaller : public tTJSDispatch
{
  protected:
    tTVPStringStream *writer;
    bool first;

  public:
    explicit DictMemberDispCaller(tTVPStringStream *writer) : writer(writer) { first = true; };

    tjs_error FuncCall(tjs_uint32 flag, const tjs_char *membername, tjs_uint32 *hint,
                       tTJSVariant *result, tjs_int numparams, tTJSVariant **param,
                       iTJSDispatch2 *objthis) override
    {
        if (numparams > 1)
        {
            tTVInteger flag = param[1]->AsInteger();
            if (!(flag & TJS_HIDDENMEMBER))
            {
                if (first)
                {
                    first = false;
                }
                else
                {
                    writer->write((tjs_char)',');
                    writer->newline();
                }
                const tjs_char *name = param[0]->GetString();
                quoteString(name, writer);
                writer->write(TJS_W("=>"));
                getVariantString(*param[2], writer);
            }
        }
        if (result)
        {
            *result = true;
        }
        return TJS_S_OK;
    }
};

static void getDictString(iTJSDispatch2 *dict, tTVPStringStream *writer)
{
    writer->write(TJS_W("%["));
    DictMemberDispCaller *caller = new DictMemberDispCaller(writer);
    tTJSVariantClosure closure(caller);
    dict->EnumMembers(TJS_IGNOREPROP, &closure, dict);
    caller->Release();
    writer->write((tjs_char)']');
}

// Array class member (Array.count), resolved after registration.
static iTJSDispatch2 *ArrayCountProp = nullptr;

static void getArrayString(iTJSDispatch2 *array, tTVPStringStream *writer)
{
    writer->write((tjs_char)'[');
    tjs_int count = 0;
    {
        tTJSVariant result;
        if (TJS_SUCCEEDED(ArrayCountProp->PropGet(0, nullptr, nullptr, &result, array)))
        {
            count = result;
        }
    }
    for (tjs_int i = 0; i < count; i++)
    {
        if (i != 0)
        {
            writer->write((tjs_char)',');
        }
        tTJSVariant result;
        if (array->PropGetByNum(TJS_IGNOREPROP, i, &result, array) == TJS_S_OK)
        {
            getVariantString(result, writer);
        }
    }
    writer->write((tjs_char)']');
}

static void getVariantString(tTJSVariant &var, tTVPStringStream *writer)
{
    switch (var.Type())
    {
        case tvtVoid:
            writer->write(TJS_W("void"));
            break;

        case tvtObject:
        {
            iTJSDispatch2 *obj = var.AsObjectNoAddRef();
            if (obj == nullptr)
            {
                writer->write(TJS_W("nullptr"));
            }
            else if (obj->IsInstanceOf(TJS_IGNOREPROP, nullptr, nullptr, TJS_W("Array"), obj) == TJS_S_TRUE)
            {
                getArrayString(obj, writer);
            }
            else
            {
                getDictString(obj, writer);
            }
        }
        break;

        case tvtString:
            quoteString(var.GetString(), writer);
            break;

        case tvtOctet:
            quoteOctet(var.AsOctetNoAddRef(), writer);
            break;

        case tvtInteger:
            writer->write(TJS_W("int "));
            writer->write((tTVInteger)var);
            break;

        case tvtReal:
            writer->write(TJS_W("real "));
            writer->write((tTVReal)var);
            break;

        default:
            writer->write(TJS_W("void"));
            break;
    };
}

//---------------------------------------------------------------------------
// Array members
//---------------------------------------------------------------------------
class ArrayAdd
{
  public:
    static tjs_error save2(tTJSVariant *result, tjs_int numparams, tTJSVariant **param,
                           iTJSDispatch2 *objthis)
    {
        if (numparams < 1)
            return TJS_E_BADPARAMCOUNT;
        std::unique_ptr<tTJSBinaryStream> stream(TJSCreateBinaryStreamForWrite(param[0]->AsString(), ttstr()));
        tTVPStringStream writer(stream.get(), numparams > 2 ? (int)*param[2] : 0);
        tjs_int count = 0;
        {
            tTJSVariant countResult;
            if (TJS_SUCCEEDED(ArrayCountProp->PropGet(0, nullptr, nullptr, &countResult, objthis)))
            {
                count = countResult;
            }
        }
        for (tjs_int i = 0; i < count; i++)
        {
            tTJSVariant value;
            if (objthis->PropGetByNum(TJS_IGNOREPROP, i, &value, objthis) == TJS_S_OK)
            {
                writer.write(value.GetString());
                writer.newline();
            }
        }
        return TJS_S_OK;
    }

    static tjs_error saveStruct2(tTJSVariant *result, tjs_int numparams, tTJSVariant **param,
                                 iTJSDispatch2 *objthis)
    {
        if (numparams < 1)
            return TJS_E_BADPARAMCOUNT;
        std::unique_ptr<tTJSBinaryStream> stream(TJSCreateBinaryStreamForWrite(param[0]->AsString(), ttstr()));
        tTVPStringStream writer(stream.get(), numparams > 2 ? (int)*param[2] : 0);
        getArrayString(objthis, &writer);
        return TJS_S_OK;
    }

    static tjs_error toStructString(tTJSVariant *result, tjs_int numparams, tTJSVariant **param,
                                    iTJSDispatch2 *objthis)
    {
        if (result)
        {
            MemoryOutput ms;
            tTVPStringStream writer(&ms, numparams > 0 ? (int)*param[0] : 0);
            getArrayString(objthis, &writer);
            // ArrayAdd writes no terminator, so the whole buffer is the result.
            *result = tTJSVariant(ttstr((const tjs_char *)ms.bytes.data(),
                                        ms.bytes.size() / sizeof(tjs_char)));
        }
        return TJS_S_OK;
    }
};

//---------------------------------------------------------------------------
// Dictionary members
//---------------------------------------------------------------------------
class DictAdd
{
  public:
    static tjs_error saveStruct2(tTJSVariant *result, tjs_int numparams, tTJSVariant **param,
                                 iTJSDispatch2 *objthis)
    {
        if (numparams < 1)
            return TJS_E_BADPARAMCOUNT;
        std::unique_ptr<tTJSBinaryStream> stream(TJSCreateBinaryStreamForWrite(param[0]->AsString(), ttstr()));
        tTVPStringStream writer(stream.get(), numparams > 2 ? (int)*param[2] : 0);
        getDictString(objthis, &writer);
        return TJS_S_OK;
    }

    static tjs_error toStructString(tTJSVariant *result, tjs_int numparams, tTJSVariant **param,
                                    iTJSDispatch2 *objthis)
    {
        if (result)
        {
            MemoryOutput ms;
            tTVPStringStream writer(&ms, numparams > 0 ? (int)*param[0] : 0);
            getDictString(objthis, &writer);
            // DictAdd terminals the same buffer with one NUL code unit; the
            // reference's narrow-to-string conversion stops there.
            writer.write((tjs_char)0);
            *result = (const tjs_char *)ms.bytes.data();
        }
        return TJS_S_OK;
    }
};

//---------------------------------------------------------------------------
// Registration
//---------------------------------------------------------------------------
static void registerMember(iTJSDispatch2 *klass, const tjs_char *classname, const tjs_char *name,
                           tTJSNativeClassMethodCallback callback, tjs_uint32 flags)
{
    static_cast<tTJSNativeClass *>(klass)->RegisterNCM(name, TJSCreateNativeClassMethod(callback),
                                                        classname, nitMethod, flags);
}

static iTJSDispatch2 *classObject(const tjs_char *name, tTJSVariant &held)
{
    // TVPExecuteExpression is the reference's lookup path for Array/Dictionary.
    // *held* keeps the class object referenced for as long as the caller needs it.
    TVPExecuteExpression(ttstr(name), nullptr, &held);
    return held.AsObjectNoAddRef();
}

static void PostRegistCallback()
{
    tTJSVariant arrayValue;
    iTJSDispatch2 *dispatch = classObject(TJS_W("Array"), arrayValue);
    if (!dispatch)
        TVPThrowExceptionMessage(TJS_W("can't get Array"));
    tTJSVariant val;
    if (TJS_FAILED(dispatch->PropGet(TJS_IGNOREPROP, TJS_W("count"), nullptr, &val, dispatch)))
    {
        TVPThrowExceptionMessage(TJS_W("can't get Array.count"));
    }
    // Held for the runtime's lifetime: the reference only releases it from
    // NCB_PRE_UNREGIST_CALLBACK, a DLL-unload path this build has no equivalent for.
    ArrayCountProp = val.AsObject();
}

void TVPRegisterSaveStruct()
{
    tTJSVariant arrayValue, dictValue;
    iTJSDispatch2 *array = classObject(TJS_W("Array"), arrayValue);
    iTJSDispatch2 *dict = classObject(TJS_W("Dictionary"), dictValue);
    if (!array || !dict)
        TVPThrowExceptionMessage(TJS_W("can't get Array/Dictionary"));

    // Array members are instance methods (flags 0).
    registerMember(array, TJS_W("Array"), TJS_W("save2"), &ArrayAdd::save2, 0);
    registerMember(array, TJS_W("Array"), TJS_W("saveStruct2"), &ArrayAdd::saveStruct2, 0);
    registerMember(array, TJS_W("Array"), TJS_W("toStructString"), &ArrayAdd::toStructString, 0);

    // ncbind preserves TJS_STATICMEMBER: callers bind the dictionary with
    // (Dictionary.toStructString incontextof value)(). Instance members would
    // become dictionary data, even when marked hidden.
    registerMember(dict, TJS_W("Dictionary"), TJS_W("saveStruct2"), &DictAdd::saveStruct2,
                   TJS_STATICMEMBER);
    registerMember(dict, TJS_W("Dictionary"), TJS_W("toStructString"), &DictAdd::toStructString,
                   TJS_STATICMEMBER);

    PostRegistCallback();
}
//---------------------------------------------------------------------------
