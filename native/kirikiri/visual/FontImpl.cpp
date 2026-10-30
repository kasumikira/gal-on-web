// Font enumeration and face registry from visual/FontImpl.cpp.
// Copyright (C) W.Dee and contributors; see ../LICENSE.
#include "FontImpl.h"
#include "StorageIntf.h"
#include "BinaryStream.h"
#include "Platform.h"
#include <ft2build.h>
#include FT_TRUETYPE_IDS_H
#include FT_SFNT_NAMES_H
#include FT_FREETYPE_H
#include <memory>
tTJSHashTable<ttstr, TVPFontNamePathInfo, tTVPttstrHash> TVPFontNames;
static ttstr TVPDefaultFontName;
const ttstr &TVPGetDefaultFontName() { TVPInitFontNames(); return TVPDefaultFontName; }
void TVPGetAllFontList(std::vector<ttstr> &list) {
    auto itend = TVPFontNames.GetLast();
    for(auto it = TVPFontNames.GetFirst(); it != itend; ++it) {
        list.push_back(it.GetKey());
    }
}

static FT_Library TVPFontLibrary;

const FT_Library TVPGetFontLibrary() {

    if(!TVPFontLibrary) {
        FT_Error error = FT_Init_FreeType(&TVPFontLibrary);
        if(error)
            TVPThrowExceptionMessage(
                (ttstr(TJS_W("Initialize FreeType failed, error = ")) +
                 TJSIntegerToString((tjs_int)error))
                    .c_str());
        TVPInitFontNames();
    }
    return TVPFontLibrary;
}

void TVPReleaseFontLibrary() {
    if(TVPFontLibrary) {
        FT_Done_FreeType(TVPFontLibrary);
    }
}
//---------------------------------------------------------------------------
static int TVPInternalEnumFonts(
    FT_Byte *pBuf, int buflen, const ttstr &FontPath,
    const std::function<tTJSBinaryStream *(TVPFontNamePathInfo *)> &getter) {
    unsigned int faceCount = 0;
    FT_Face fontface;
    FT_Error error =
        FT_New_Memory_Face(TVPGetFontLibrary(), pBuf, buflen, 0, &fontface);
    if(error) {
        TVPAddLog(ttstr(TJS_W("Load Font \"") + FontPath + "\" failed (" +
                        TJSIntegerToString((int)error) + ")"));
        return faceCount;
    }
    int nFaceNum = fontface->num_faces;
    for(int i = 0; i < nFaceNum; ++i) {
        if(i > 0) {
            if(FT_New_Memory_Face(TVPGetFontLibrary(), pBuf, buflen, i,
                                  &fontface)) {
                continue;
            }
        }
        if(FT_IS_SCALABLE(fontface)) {
            FT_UInt namecount = FT_Get_Sfnt_Name_Count(fontface);
            int addCount = 0;
            for(FT_UInt j = 0; j < namecount; ++j) {
                FT_SfntName name;
                if(FT_Get_Sfnt_Name(fontface, j, &name)) {
                    continue;
                }
                if(name.name_id != TT_NAME_ID_FONT_FAMILY) {
                    continue;
                }
                if(name.platform_id != TT_PLATFORM_MICROSOFT) {
                    continue;
                }
                switch(name.language_id) { // for CJK names
                    case TT_MS_LANGID_JAPANESE_JAPAN:
                    case TT_MS_LANGID_CHINESE_GENERAL:
                    case TT_MS_LANGID_CHINESE_TAIWAN:
                    case TT_MS_LANGID_CHINESE_PRC:
                    case TT_MS_LANGID_CHINESE_HONG_KONG:
                    case TT_MS_LANGID_CHINESE_SINGAPORE:
                    case TT_MS_LANGID_KOREAN_EXTENDED_WANSUNG_KOREA:
                    case TT_MS_LANGID_KOREAN_JOHAB_KOREA:
                        break;
                    default:
                        continue;
                }
                ttstr fontname;
                if(name.encoding_id == TT_MS_ID_UNICODE_CS) {
                    std::vector<tjs_char> tmp;
                    int namelen = name.string_len / 2;
                    tmp.resize(namelen + 1);
                    for(int k = 0; k < namelen; ++k) {
                        tmp[k] = (name.string[k * 2] << 8) |
                            (name.string[k * 2 + 1]);
                    }
                    fontname = &tmp.front();
                } else {
                    continue;
                }
                TVPFontNamePathInfo info;
                info.Path = FontPath;
                info.Index = i;
                info.Getter = getter;
                TVPFontNames.Add(fontname, info);
                addCount = 1;
            }
            /*if (!addCount)*/ {
                ttstr fontname((tjs_nchar *)fontface->family_name);
                TVPFontNamePathInfo info;
                info.Path = FontPath;
                info.Index = i;
                info.Getter = getter;
                TVPFontNames.Add(fontname, info);
            }
            ++faceCount;
        }

        FT_Done_Face(fontface);
    }
    return faceCount;
}

/**
 *  only support little word!!!
 * @param FontPath font path str
 * @return load failed return 0, otherwise > 0
 */
int TVPEnumFontsProc(const ttstr &FontPath) {
    if(!TVPIsExistentStorageNoSearch(FontPath)) {
        return 0;
    }

    tTJSBinaryStream *Stream = TVPCreateStream(FontPath, TJS_BS_READ);
    if(!Stream) {
        return 0;
    }
    int bufflen = Stream->GetSize();
    std::vector<FT_Byte> buf;
    buf.resize(bufflen);
    Stream->ReadBuffer(&buf.front(), bufflen);
    delete Stream;
    return TVPInternalEnumFonts(&buf.front(), bufflen, FontPath, nullptr);
}

tTJSBinaryStream *TVPCreateFontStream(const ttstr &fontname) {
    TVPFontNamePathInfo *info = TVPFindFont(fontname);
    if(!info) {
        info = TVPFontNames.Find(TVPDefaultFontName);
        if(!info)
            return nullptr;
    }
    if(info->Getter) {
        return info->Getter(info);
    }
    return TVPCreateStream(info->Path, TJS_BS_READ);
}

void TVPInitFontNames() {
    static bool initialized = false;
    if (initialized) return;
    initialized = true;
    // The reference prioritizes a project default font, then the bundled
    // Droid fallback. Both are read through the shared JS storage service.
    for (const auto *path : {TJS_W("default.ttf"), TJS_W("default.ttc"),
                             TJS_W("default.otf"), TJS_W("default.otc"),
                             TJS_W("engine-resource://fonts/default.ttf")}) {
        if (TVPEnumFontsProc(path)) break;
    }
    if (!TVPFontNames.GetCount())
        TVPThrowExceptionMessage(TJS_W("No usable default font was found"));
    TVPDefaultFontName = TVPFontNames.GetLast().GetKey();
}

TVPFontNamePathInfo *TVPFindFont(const ttstr &fontname) {
    TVPInitFontNames();
    TVPFontNamePathInfo *info = nullptr;
    if (!fontname.IsEmpty() && fontname[0] == TJS_W('@')) info = TVPFontNames.Find(fontname.c_str() + 1);
    return info ? info : TVPFontNames.Find(fontname);
}

tjs_uint32 tTVPttstrHash::Make(const ttstr &val) {
    const tjs_char *ptr = val.c_str();
    if(*ptr == 0)
        return 0;
    tjs_uint32 v = 0;
    while(*ptr) {
        v += *ptr;
        v += (v << 10);
        v ^= (v >> 6);
        ptr++;
    }
    v += (v << 3);
    v ^= (v >> 11);
    v += (v << 15);
    if(!v)
        v = (tjs_uint32)-1;
    return v;
}
