// -*- coding: utf-8 -*-
//---------------------------------------------------------------------------
// expat プラグイン (吉里吉里Z 版)
//
//   expat を用いた XML パーサ。XMLParser クラスを登録する。
//   パース中は対象オブジェクトの startElement / endElement / characterData 等の
//   メソッドがコールバックされる (DOM 実装例は XML.tjs 参照)。
//
//   Author: わたなべごう
//   プラグイン自体のライセンスは吉里吉里(krkr) 本体に準拠。expat のライセンスは
//   下記 expat_copyright を参照。
//
//   ■ 近代化について (旧 Win32 専用実装からの移植)
//     ・windows.h / DllMain / `_stdcall _export` / MSVC 限定 #error を撤去。
//     ・UTF-16<->UTF-8 変換を WideCharToMultiByte から TVPUtf8ToWideCharString /
//       TVPWideCharToUtf8String (エンジン提供・全 PF 共通) へ置換。
//     ・ファイル入力を Win32 IStream から iTJSBinaryStream(TVPCreateStream) へ。
//     ・V2Link/V2Unlink の手書き・生 TJS_BEGIN_NATIVE_MEMBERS を撤去し ncbind 化。
//     全ビルドバリアント(WIN/SDL/LIB)でビルド可能。
//---------------------------------------------------------------------------

#include "ScriptMgnIntf.h"
#include "ncbind.hpp"
#include "tjsDictionary.h"
#include <boost/locale/encoding.hpp>
#include <memory>

#include <expat.h>
#include <string>
#include <vector>
#include <string.h>

namespace {

//---------------------------------------------------------------------------
static const char *expat_copyright =
"----- EXPAT Copyright START -----\n"
"Copyright (c) 1998, 1999, 2000 Thai Open Source Software Center Ltd\n"
"                               and Clark Cooper\n"
"Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006 Expat maintainers.\n"
"\n"
"Permission is hereby granted, free of charge, to any person obtaining\n"
"a copy of this software and associated documentation files (the\n"
"\"Software\"), to deal in the Software without restriction, including\n"
"without limitation the rights to use, copy, modify, merge, publish,\n"
"distribute, sublicense, and/or sell copies of the Software, and to\n"
"permit persons to whom the Software is furnished to do so, subject to\n"
"the following conditions:\n"
"\n"
"The above copyright notice and this permission notice shall be included\n"
"in all copies or substantial portions of the Software.\n"
"\n"
"THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\n"
"EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF\n"
"MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.\n"
"IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY\n"
"CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,\n"
"TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE\n"
"SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n"
"----- EXPAT Copyright END -----\n";

//---------------------------------------------------------------------------
// UTF-8(char, expat) <-> tjs_char(ttstr) 変換ヘルパ (全 PF 共通)
//---------------------------------------------------------------------------
static ttstr Utf8ToTtstr(const char *s, int len) {
    if (!s) return ttstr();
    const std::string bytes = len < 0 ? std::string(s) : std::string(s, len);
    const auto text = boost::locale::conv::utf_to_utf<tjs_char>(bytes);
    return ttstr(text.data(), text.size());
}
static std::string TtstrToUtf8(const tjs_char *s) {
    return s ? boost::locale::conv::utf_to_utf<char>(s) : std::string();
}

//---------------------------------------------------------------------------
// TJS メンバ操作ヘルパ
//---------------------------------------------------------------------------
static tTJSVariant getMember(iTJSDispatch2 *dispatch, const tjs_char *name) {
	tTJSVariant val;
	if (TJS_FAILED(dispatch->PropGet(TJS_IGNOREPROP, name, NULL, &val, dispatch))) {
		ttstr msg = TJS_W("can't get member:");
		msg += name;
		TVPThrowExceptionMessage(msg.c_str());
	}
	return tTJSVariant(val.AsObjectNoAddRef(), nullptr);
}
static bool isValidMember(iTJSDispatch2 *dispatch, const tjs_char *name) {
	return dispatch->IsValid(TJS_IGNOREPROP, name, NULL, dispatch) == TJS_S_TRUE;
}

//---------------------------------------------------------------------------
// expat ハンドラ群 (userData = コールバック対象の TJS オブジェクト)
//---------------------------------------------------------------------------
static void XMLCALL startElement(void *userData, const XML_Char *name, const XML_Char **atts) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("startElement"));

	tTJSVariant var1 = tTJSVariant(Utf8ToTtstr(name, -1));

	iTJSDispatch2 *dict = TJSCreateDictionaryObject();
	for (const XML_Char **p = atts; *p; p += 2) {
		ttstr key = Utf8ToTtstr(p[0], -1);
		tTJSVariant v = tTJSVariant(Utf8ToTtstr(p[1], -1));
		dict->PropSet(TJS_MEMBERENSURE, key.c_str(), NULL, &v, dict);
	}
	tTJSVariant var2 = tTJSVariant(dict);
	dict->Release();

	tTJSVariant *vars[2] = { &var1, &var2 };
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 2, vars, obj);
}

static void XMLCALL endElement(void *userData, const XML_Char *name) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("endElement"));
	tTJSVariant var1 = tTJSVariant(Utf8ToTtstr(name, -1));
	tTJSVariant *vars[1] = { &var1 };
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 1, vars, obj);
}

static void XMLCALL characterData(void *userData, const XML_Char *s, int len) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("characterData"));
	tTJSVariant var1 = tTJSVariant(Utf8ToTtstr(s, len));
	tTJSVariant *vars[1] = { &var1 };
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 1, vars, obj);
}

static void XMLCALL processingInstruction(void *userData, const XML_Char *target, const XML_Char *data) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("processingInstruction"));
	tTJSVariant var1 = tTJSVariant(Utf8ToTtstr(target, -1));
	tTJSVariant var2 = tTJSVariant(Utf8ToTtstr(data, -1));
	tTJSVariant *vars[2] = { &var1, &var2 };
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 2, vars, obj);
}

static void XMLCALL comment(void *userData, const XML_Char *data) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("comment"));
	tTJSVariant var1 = tTJSVariant(Utf8ToTtstr(data, -1));
	tTJSVariant *vars[1] = { &var1 };
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 1, vars, obj);
}

static void XMLCALL startCdataSection(void *userData) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("startCdataSection"));
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 0, NULL, obj);
}

static void XMLCALL endCdataSection(void *userData) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("endCdataSection"));
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 0, NULL, obj);
}

static void XMLCALL defaultHandler(void *userData, const XML_Char *s, int len) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("defaultHandler"));
	tTJSVariant var1 = tTJSVariant(Utf8ToTtstr(s, len));
	tTJSVariant *vars[1] = { &var1 };
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 1, vars, obj);
}

static void XMLCALL defaultHandlerExpand(void *userData, const XML_Char *s, int len) {
	iTJSDispatch2 *obj = (iTJSDispatch2*)userData;
	tTJSVariant method = getMember(obj, TJS_W("defaultHandlerExpand"));
	tTJSVariant var1 = tTJSVariant(Utf8ToTtstr(s, len));
	tTJSVariant *vars[1] = { &var1 };
	method.AsObjectNoAddRef()->FuncCall(0, NULL, NULL, NULL, 1, vars, obj);
}

//---------------------------------------------------------------------------
// XMLParser クラス (ncbind ネイティブクラス)
//---------------------------------------------------------------------------
#define entryHandler(setter, name) \
	if (isValidMember(target, TJS_W(#name))) { XML_Set##setter##Handler(parser, name); }
#define entryHandler2(setter, name) \
	if (isValidMember(target, TJS_W(#name))) { XML_Set##setter(parser, name); }

class XMLParser {
	XML_Parser     parser;
	iTJSDispatch2 *ctorTarget;  // コンストラクタで指定された対象 (AddRef 保持) / NULL
	iTJSDispatch2 *owner;       // 生成時の objthis (非 AddRef。既定コールバック対象)

	// コールバック対象の解決: ctor 指定 > parse 第2引数 > owner(生成オブジェクト)
	iTJSDispatch2 *resolveTarget(tTJSVariant *explicitTarget) {
		if (ctorTarget) return ctorTarget;
		if (explicitTarget && explicitTarget->Type() == tvtObject)
			return explicitTarget->AsObjectNoAddRef();
		return owner;
	}

	void initHandlers(iTJSDispatch2 *target) {
		XML_ParserReset(parser, "UTF-8");
		XML_SetUserData(parser, target);
		entryHandler(StartElement, startElement);
		entryHandler(EndElement, endElement);
		entryHandler(CharacterData, characterData);
		entryHandler(ProcessingInstruction, processingInstruction);
		entryHandler(Comment, comment);
		entryHandler(StartCdataSection, startCdataSection);
		entryHandler(EndCdataSection, endCdataSection);
		entryHandler2(DefaultHandler, defaultHandler);
		entryHandler2(DefaultHandlerExpand, defaultHandlerExpand);
	}

	bool doParseText(const ttstr &text, iTJSDispatch2 *target) {
		if (!parser) return false;
		initHandlers(target);
		std::string utf8 = TtstrToUtf8(text.c_str());
		return XML_Parse(parser, utf8.data(), (int)utf8.size(), XML_TRUE) == XML_STATUS_OK;
	}

	bool doParseStorage(const ttstr &filename, iTJSDispatch2 *target) {
		if (!parser) return false;
		initHandlers(target);
		tTJSBinaryStream *in = TJSCreateBinaryStreamForRead(filename, ttstr());
		if (!in)
			TVPThrowExceptionMessage((ttstr(TJS_W("cannot open : ")) + filename).c_str());
		bool ret = false;
		try {
			char buf[8192];
			for (;;) {
				tjs_uint len = in->Read(buf, sizeof buf);
				bool last = len < sizeof buf;
				ret = XML_Parse(parser, buf, (int)len, last ? XML_TRUE : XML_FALSE) == XML_STATUS_OK;
				if (last || !ret) break;
			}
		} catch (...) {
			delete in;
			throw;
		}
		delete in;
		return ret;
	}

public:
	XMLParser(iTJSDispatch2 *owner_, iTJSDispatch2 *ctorTarget_)
		: parser(XML_ParserCreate(NULL)), ctorTarget(ctorTarget_), owner(owner_) {
		if (ctorTarget) ctorTarget->AddRef();
	}
	~XMLParser() {
		if (parser) XML_ParserFree(parser);
		if (ctorTarget) ctorTarget->Release();
	}

	// ncbind ファクトリ (objthis と任意のコールバック対象を受け取る)
	static tjs_error 
	Factory(XMLParser **inst, tjs_int numparams, tTJSVariant **param, iTJSDispatch2 *objthis) {
		iTJSDispatch2 *t = (numparams > 0 && param[0]->Type() == tvtObject)
			? param[0]->AsObjectNoAddRef() : NULL;
		*inst = new XMLParser(objthis, t);
		return TJS_S_OK;
	}

	// parse(text[, target]) : テキストをパース。成功で true
	static tjs_error 
	parse(tTJSVariant *result, tjs_int numparams, tTJSVariant **param, XMLParser *self) {
		if (!self) return TJS_E_NATIVECLASSCRASH;
		if (numparams < 1) return TJS_E_BADPARAMCOUNT;
		iTJSDispatch2 *target = self->resolveTarget(numparams > 1 ? param[1] : NULL);
		ttstr text = *param[0];
		bool ret = self->doParseText(text, target);
		if (result) *result = ret;
		return TJS_S_OK;
	}

	// parseStorage(filename[, target]) : ファイルをパース。成功で true
	static tjs_error 
	parseStorage(tTJSVariant *result, tjs_int numparams, tTJSVariant **param, XMLParser *self) {
		if (!self) return TJS_E_NATIVECLASSCRASH;
		if (numparams < 1) return TJS_E_BADPARAMCOUNT;
		iTJSDispatch2 *target = self->resolveTarget(numparams > 1 ? param[1] : NULL);
		ttstr filename = *param[0];
		bool ret = self->doParseStorage(filename, target);
		if (result) *result = ret;
		return TJS_S_OK;
	}

	// プロパティ (読み取り専用)
	tjs_int    getErrorCode()          const { return parser ? (tjs_int)XML_GetErrorCode(parser) : (tjs_int)XML_ERROR_NONE; }
	ttstr      getErrorString()        const { return parser ? Utf8ToTtstr(XML_ErrorString(XML_GetErrorCode(parser)), -1) : ttstr(); }
	tTVInteger getCurrentByteIndex()   const { return parser ? (tTVInteger)XML_GetCurrentByteIndex(parser)   : 0; }
	tTVInteger getCurrentLineNumber()  const { return parser ? (tTVInteger)XML_GetCurrentLineNumber(parser)  : 0; }
	tTVInteger getCurrentColumnNumber()const { return parser ? (tTVInteger)XML_GetCurrentColumnNumber(parser): 0; }
	tTVInteger getCurrentByteCount()   const { return parser ? (tTVInteger)XML_GetCurrentByteCount(parser)   : 0; }
};

} // namespace
#define NCB_MODULE_NAME TJS_W("expat.dll")
NCB_REGISTER_CLASS(XMLParser) {
    Factory(&Class::Factory);
    RawCallback(TJS_W("parse"), &Class::parse, 0);
    RawCallback(TJS_W("parseStorage"), &Class::parseStorage, 0);
    Property(TJS_W("errorCode"), &Class::getErrorCode, 0);
    Property(TJS_W("errorString"), &Class::getErrorString, 0);
    Property(TJS_W("currentByteIndex"), &Class::getCurrentByteIndex, 0);
    Property(TJS_W("currentLineNumber"), &Class::getCurrentLineNumber, 0);
    Property(TJS_W("currentColumnNumber"), &Class::getCurrentColumnNumber, 0);
    Property(TJS_W("currentByteCount"), &Class::getCurrentByteCount, 0);
}
