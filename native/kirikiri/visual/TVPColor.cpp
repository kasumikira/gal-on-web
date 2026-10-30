// System color mapping from core/environ/Application.cpp.
// Copyright (C) W.Dee and contributors; see ../LICENSE.
#include "TVPColor.h"
unsigned long ColorToRGB(unsigned int col) {
    // 0xBBGGRR
    switch(col) {
        case clScrollBar:
            return 0xc8c8c8;
        case clBackground:
            return 0;
        case clActiveCaption:
            return 0xd1b499;
        case clInactiveCaption:
            return 0xdbcdbf;
        case clMenu:
            return 0xf0f0f0;
        case clWindow:
            return 0xffffff;
        case clWindowFrame:
            return 0x646464;
        case clMenuText:
        case clWindowText:
            return 0;
        case clCaptionText:
            return 0;
        case clActiveBorder:
            return 0xb4b4b4;
        case clInactiveBorder:
            return 0xfcf7f4;
        case clAppWorkSpace:
            return 0xababab;
        case clHighlight:
            return 0xff9933;
        case clHighlightText:
            return 0xffffff;
        case clBtnFace:
            return 0xf0f0f0;
        case clBtnShadow:
            return 0xa0a0a0;
        case clGrayText:
            return 0x6d6d6d;
        case clBtnText:
            return 0;
        case clInactiveCaptionText:
            return 0x544e43;
        case clBtnHighlight:
            return 0xffffff;
        case cl3DDkShadow:
            return 0x696969;
        case cl3DLight:
            return 0xe3e3e3;
        case clInfoText:
            return 0;
        case clInfoBk:
            return 0xe1ffff;
        case clUnknown:
            return 0;
        case clHotLight:
            return 0xcc6600;
        case clGradientActiveCaption:
            return 0xead1b9;
        case clGradientInactiveCaption:
            return 0xf2e4d7;
        case clMenuLight:
            return 0xff9933;
        case clMenuBar:
            return 0xf0f0f0;
        default:
            return col & 0xFFFFFF;
    }
}
