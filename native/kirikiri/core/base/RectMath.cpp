//---------------------------------------------------------------------------
/*
        TVP2 ( T Visual Presenter 2 )  A script authoring tool
        Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
// Complex Rectangle Class
//---------------------------------------------------------------------------
#define NOMINMAX
#include "tjsCommHead.h"

#include "ComplexRect.h"
#include <vector>
#include <algorithm>

// Some algorithms and ideas are based on implementation of Mozilla,
// gfx/src/nsRegion.cpp.

//---------------------------------------------------------------------------
// TVPIntersectRect
//---------------------------------------------------------------------------
bool TVPIntersectRect(tTVPRect *dest, const tTVPRect &src1,
                      const tTVPRect &src2) {
    tjs_int left = std::max(src1.left, src2.left);
    tjs_int top = std::max(src1.top, src2.top);
    tjs_int right = std::min(src1.right, src2.right);
    tjs_int bottom = std::min(src1.bottom, src2.bottom);

    if(right > left && bottom > top) {
        if(dest) {
            dest->left = left;
            dest->top = top;
            dest->right = right;
            dest->bottom = bottom;
        }
        return true;
    }
    return false;
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// TVPUnionRect
//---------------------------------------------------------------------------
bool TVPUnionRect(tTVPRect *dest, const tTVPRect &src1, const tTVPRect &src2) {
    tjs_int left = std::min(src1.left, src2.left);
    tjs_int top = std::min(src1.top, src2.top);
    tjs_int right = std::max(src1.right, src2.right);
    tjs_int bottom = std::max(src1.bottom, src2.bottom);

    if(right > left && bottom > top) {

        if(dest) {
            dest->left = left;
            dest->top = top;
            dest->right = right;
            dest->bottom = bottom;
        }
        return true;
    }

    return false;
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
