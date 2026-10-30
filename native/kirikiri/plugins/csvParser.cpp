//---------------------------------------------------------------------------
// CSVParser native class, adapted from cpp/plugins/csvParser.cpp.
//
// The original TJS class is installed through an ncbind module callback.
// The unused reference Array.clear registration cache is omitted.
//
// parse() invokes the target's doLine in the current call frame, matching the
// reference's nested FuncCall rather than the asynchronous JS implementation it
// replaces.
//---------------------------------------------------------------------------
#include "ScriptMgnIntf.h"
#include "ncbind.hpp"
#include "tjsArray.h"
#include "tjsNative.h"

#include <boost/locale/encoding.hpp>
#include <cstdio>
#include <string>

#define NCB_MODULE_NAME TJS_W("csvParser.dll")

// tTJSNativeClassForPlugin has no ClassID member, so the plugin class id lives in
// a translation-unit static. This is the same override the reference applies
// before its TJS_BEGIN_NATIVE_MEMBERS block.
#undef TJS_NCM_REG_THIS
#undef TJS_NATIVE_SET_ClassID
#undef TJS_NATIVE_CLASSID_NAME
#define TJS_NCM_REG_THIS classobj
#define TJS_NATIVE_SET_ClassID TJS_NATIVE_CLASSID_NAME = TJS_NCM_CLASSID;
#define TJS_NATIVE_CLASSID_NAME ClassID_CSVParser
static tjs_int32 TJS_NATIVE_CLASSID_NAME = -1;

//---------------------------------------------------------------------------

class IFile
{
  public:
    virtual ~IFile(){};
    virtual bool addNextLine(ttstr &str) = 0;
};

class IFileStr : public IFile
{
    ttstr dat;
    tjs_uint pos;

  public:
    IFileStr(const ttstr &str)
    {
        dat = str;
        pos = 0;
    }

    int getc() { return pos < (tjs_uint)dat.length() ? dat[pos++] : EOF; }

    void ungetc()
    {
        if (pos > 0)
        {
            pos--;
        }
    }

    bool eof() { return pos >= (tjs_uint)dat.length(); }

    // Return true when c ends the line, consuming the "\n" of a "\r\n" pair.
    bool endOfLine(tjs_char c)
    {
        bool eol = (c == '\r' || c == '\n');
        if (c == '\r')
        {
            c = getc();
            if (!eof() && c != '\n')
            {
                ungetc();
            }
        }
        return eol;
    }

    bool addNextLine(ttstr &str) override
    {
        int l = 0;
        int c;
        while ((c = getc()) != EOF && !endOfLine((tjs_char)c))
        {
            str += (tjs_char)c;
            l++;
        }
        // A trailing "\r\n" leaves l == 0 and c == EOF, which reports no line.
        return l > 0 || c != EOF;
    }
};

//---------------------------------------------------------------------------

class NI_CSVParser : public tTJSNativeInstance
{
  protected:
    iTJSDispatch2 *target;
    IFile *file;
    tjs_int32 lineNo;

    // Field separator.
    tjs_char separator;

    // Line separator inserted for quoted fields that span lines.
    ttstr newline;

    // Current line, kept in wide characters.
    ttstr line;

    bool addline() { return file->addNextLine(line); }

    int find(ttstr &line, tjs_char ch, int start)
    {
        int i;
        for (i = start; i < line.length(); i++)
        {
            if (ch == line[i])
            {
                return i;
            }
        }
        return i;
    }

    void split(iTJSDispatch2 *fields)
    {
        ttstr fld;
        int i, j;
        tjs_int cnt = 0;

        if (line.length() == 0)
        {
            return;
        }
        i = 0;
        do
        {
            if (i < line.length() && line[i] == '"')
            {
                ++i;
                fld = TJS_W("");
                j = i;
                do
                {
                    for (; j < line.length(); j++)
                    {
                        if (line[j] == '"' && line[++j] != '"')
                        {
                            int k = find(line, separator, j);
                            if (k > line.length())
                            {
                                k = line.length();
                            }
                            for (k -= j; k-- > 0;)
                                fld += line[j++];
                            goto next;
                        }
                        fld += line[j];
                    }
                    // Quoted field continues on the next line.
                    fld += newline;
                } while (addline());
            }
            else
            {
                j = find(line, separator, i);
                if (j > line.length())
                {
                    j = line.length();
                }
                fld = ttstr(line.c_str() + i, j - i);
            }
        next:
        {
            tTJSVariant var(fld);
            fields->PropSetByNum(TJS_MEMBERENSURE, cnt++, &var, fields);
        }
            i = j + 1;
        } while (j < line.length());
    }

  public:
    NI_CSVParser()
    {
        target = nullptr;
        file = nullptr;
        lineNo = 0;
        separator = ',';
        newline = TJS_W("\r\n");
    }

    ~NI_CSVParser() override { clear(); }

    tjs_error Construct(tjs_int numparams, tTJSVariant **param,
                        iTJSDispatch2 *tjs_obj) override
    {
        if (numparams > 0)
        {
            target = param[0]->AsObject();
            if (numparams > 1)
            {
                separator = (tjs_char)(tjs_int)*param[1];
                if (numparams > 2)
                {
                    newline = *param[2];
                }
            }
        }
        return TJS_S_OK;
    }

    void clear()
    {
        if (file)
        {
            delete file;
            file = nullptr;
        }
    }

    void Invalidate() override
    {
        clear();
        if (target)
        {
            target->Release();
            target = nullptr;
        }
    }

    void init(tTJSVariantString *text)
    {
        clear();
        file = new IFileStr(text);
        lineNo = 0;
    }

    void initStorage(tTJSVariantString *filename, bool utf8 = false, const tjs_char *mode = nullptr)
    {
        clear();
        ttstr text;
        if (!mode)
        {
            tTJSBinaryStream *stream = TJSCreateBinaryStreamForRead(filename, ttstr());
            if (!stream)
            {
                TVPThrowExceptionMessage(TJS_W("can't open storage:%1"), ttstr(filename));
            }
            const tjs_uint64 size = stream->GetSize();
            std::string bytes;
            bytes.resize((size_t)size);
            if (size)
            {
                stream->ReadBuffer(bytes.data(), (tjs_uint)size);
            }
            delete stream;
            // ttstr's implicit narrow conversion stops at the first NUL, which is
            // the same truncation the reference gets from its NUL-terminated buffer.
            text = utf8 ? ttstr(boost::locale::conv::utf_to_utf<char16_t>(bytes).c_str())
                        : ttstr(bytes.c_str());
        }
        else
        {
            iTJSTextReadStream *stream = TVPCreateTextStreamForRead(ttstr(filename), mode);
            if (!stream)
            {
                TVPThrowExceptionMessage(TJS_W("can't open storage:%1"), ttstr(filename));
            }
            stream->Read(text, 0);
            delete stream;
        }
        file = new IFileStr(text);
        lineNo = 0;
    }

    bool getNextLine(tTJSVariant *result = nullptr)
    {
        bool ret = false;
        if (file)
        {
            line = TJS_W("");
            if (addline())
            {
                lineNo++;
                iTJSDispatch2 *fields = TJSCreateArrayObject();
                split(fields);
                if (result)
                {
                    result->SetObject(fields, fields);
                }
                fields->Release();
                ret = true;
            }
            else
            {
                clear();
            }
        }
        return ret;
    }

    tjs_int32 getLineNumber() { return lineNo; }

    void parse(iTJSDispatch2 *objthis)
    {
        iTJSDispatch2 *target = this->target ? this->target : objthis;
        if (file && isValidMember(target, TJS_W("doLine")))
        {
            iTJSDispatch2 *method = getMember(target, TJS_W("doLine"));
            tTJSVariant result;
            while (getNextLine(&result))
            {
                tTJSVariant var2(lineNo);
                tTJSVariant *vars[2];
                vars[0] = &result;
                vars[1] = &var2;
                method->FuncCall(0, nullptr, nullptr, nullptr, 2, vars, target);
            }
            clear();
            method->Release();
        }
    }

  protected:
    static bool isValidMember(iTJSDispatch2 *dispatch, const tjs_char *name)
    {
        return dispatch->IsValid(TJS_IGNOREPROP, name, nullptr, dispatch) == TJS_S_TRUE;
    }

    static iTJSDispatch2 *getMember(iTJSDispatch2 *dispatch, const tjs_char *name)
    {
        tTJSVariant val;
        if (TJS_FAILED(dispatch->PropGet(TJS_IGNOREPROP, name, nullptr, &val, dispatch)))
        {
            ttstr msg = TJS_W("can't get member:");
            msg += name;
            TVPThrowExceptionMessage(msg.c_str());
        }
        return val.AsObject();
    }
};

static iTJSNativeInstance *Create_NI_CSVParser() { return new NI_CSVParser(); }

tTJSNativeClass *TVPCreateNativeClass_CSVParser()
{
    tTJSNativeClassForPlugin *classobj =
        TJSCreateNativeClassForPlugin(TJS_W("CSVParser"), Create_NI_CSVParser);

    TJS_BEGIN_NATIVE_MEMBERS(/*TJS class name*/ CSVParser)

    TJS_DECL_EMPTY_FINALIZE_METHOD

    TJS_BEGIN_NATIVE_CONSTRUCTOR_DECL(
        /*var.name*/ _this,
        /*var.type*/ NI_CSVParser,
        /*TJS class name*/ CSVParser) {
        return TJS_S_OK;
    }
    TJS_END_NATIVE_CONSTRUCTOR_DECL(/*TJS class name*/ CSVParser)

    TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ init) {
        TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                                /*var. type*/ NI_CSVParser);
        if (numparams < 1)
            return TJS_E_BADPARAMCOUNT;
        _this->init(param[0]->AsStringNoAddRef());
        return TJS_S_OK;
    }
    TJS_END_NATIVE_METHOD_DECL(/*func. name*/ init)

    TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ initStorage) {
        TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                                /*var. type*/ NI_CSVParser);
        if (numparams < 1)
            return TJS_E_BADPARAMCOUNT;
        _this->initStorage(param[0]->AsStringNoAddRef(),
            TJS_PARAM_EXIST(1) && param[1]->Type() != tvtString && (tjs_int)*param[1] != 0,
            !TJS_PARAM_EXIST(1) ? TJS_W("") : param[1]->Type() == tvtString ? param[1]->GetString() : nullptr);
        return TJS_S_OK;
    }
    TJS_END_NATIVE_METHOD_DECL(/*func. name*/ initStorage)

    TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ getNextLine) {
        TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                                /*var. type*/ NI_CSVParser);
        _this->getNextLine(result);
        return TJS_S_OK;
    }
    TJS_END_NATIVE_METHOD_DECL(/*func. name*/ getNextLine)

    TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ parse) {
        TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                                /*var. type*/ NI_CSVParser);
        if (numparams > 0)
        {
            _this->init(param[0]->AsStringNoAddRef());
        }
        _this->parse(objthis);
        return TJS_S_OK;
    }
    TJS_END_NATIVE_METHOD_DECL(/*func. name*/ parse)

    TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ parseStorage) {
        TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                                /*var. type*/ NI_CSVParser);
        if (numparams > 0)
        {
            _this->initStorage(param[0]->AsStringNoAddRef(),
                TJS_PARAM_EXIST(1) && param[1]->Type() != tvtString && (tjs_int)*param[1] != 0,
                !TJS_PARAM_EXIST(1) ? TJS_W("") : param[1]->Type() == tvtString ? param[1]->GetString() : nullptr);
        }
        _this->parse(objthis);
        return TJS_S_OK;
    }
    TJS_END_NATIVE_METHOD_DECL(/*func. name*/ parseStorage)

    TJS_BEGIN_NATIVE_PROP_DECL(currentLineNumber){
        TJS_BEGIN_NATIVE_PROP_GETTER{ TJS_GET_NATIVE_INSTANCE(
            /*var. name*/ _this, /*var. type*/ NI_CSVParser);
    *result = _this->getLineNumber();
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER
TJS_DENY_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(currentLineNumber)

TJS_END_NATIVE_MEMBERS

return classobj;
}

//---------------------------------------------------------------------------
// Installs the CSVParser global class. Called once when the runtime is created,
// mirroring the reference's NCB_PRE_REGIST_CALLBACK entry point.
//---------------------------------------------------------------------------
void TVPRegisterCSVParser()
{
    tTJSNativeClass *klass = TVPCreateNativeClass_CSVParser();
    tTJSVariant value(klass, nullptr);
    klass->Release();
    TVPGetScriptEngine()->GetGlobalNoAddRef()->PropSet(TJS_MEMBERENSURE, TJS_W("CSVParser"),
                                                       nullptr, &value, nullptr);
}
//---------------------------------------------------------------------------

NCB_PRE_REGIST_CALLBACK(TVPRegisterCSVParser);
