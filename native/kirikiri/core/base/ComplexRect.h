//---------------------------------------------------------------------------
/*
        TVP2 ( T Visual Presenter 2 )  A script authoring tool
        Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
// Complex Rectangle Class
//---------------------------------------------------------------------------

#ifndef ComplexRectUnitH
#define ComplexRectUnitH

#include <stdlib.h>
#include "tjsTypes.h"

//---------------------------------------------------------------------------
// tTVPRect - intersection and union
//---------------------------------------------------------------------------
struct tTVPRect;
extern bool TVPIntersectRect(tTVPRect *dest, const tTVPRect &src1,
                             const tTVPRect &src2);
extern bool TVPUnionRect(tTVPRect *dest, const tTVPRect &src1,
                         const tTVPRect &src2);
//---------------------------------------------------------------------------

/*[*/

//---------------------------------------------------------------------------
// tTVPRect - simple rectangle structure
//---------------------------------------------------------------------------
#pragma pack(push, 4)
struct tTVPPoint {
    tjs_int x;
    tjs_int y;
};
#pragma pack(pop)
//---------------------------------------------------------------------------
struct tTVPPointD {
    double x;
    double y;
};
//---------------------------------------------------------------------------
struct tTVPRect {
    tTVPRect(tjs_int l, tjs_int t, tjs_int r, tjs_int b) {
        left = l, top = t, right = r, bottom = b;
    }

    tTVPRect() {};

    union {
        struct {
            tjs_int left;
            tjs_int top;
            tjs_int right;
            tjs_int bottom;
        };

        struct {
            // capital style
            tjs_int Left;
            tjs_int Top;
            tjs_int Right;
            tjs_int Bottom;
        };

        struct {
            tTVPPoint upper_left;
            tTVPPoint bottom_right;
        };

        tjs_int array[4];
    };

    tjs_int get_width() const { return right - left; }
    tjs_int get_height() const { return bottom - top; }

    void set_width(tjs_int w) { right = left + w; }
    void set_height(tjs_int h) { bottom = top + h; }

    void add_offsets(tjs_int x, tjs_int y) {
        left += x;
        right += x;
        top += y;
        bottom += y;
    }

    void set_offsets(tjs_int x, tjs_int y) {
        tjs_int w = get_width();
        tjs_int h = get_height();
        left = x;
        top = y;
        right = x + w;
        bottom = y + h;
    }

    void set_size(tjs_int w, tjs_int h) {
        right = left + w;
        bottom = top + h;
    }

    void clear() { left = top = right = bottom = 0; }

    bool is_empty() const { return left >= right || top >= bottom; }

    bool do_union(const tTVPRect &ref) {
        if(ref.is_empty())
            return false;
        if(left > ref.left)
            left = ref.left;
        if(top > ref.top)
            top = ref.top;
        if(right < ref.right)
            right = ref.right;
        if(bottom < ref.bottom)
            bottom = ref.bottom;
        return true;
    }
#ifndef __TP_STUB_H__
    bool clip(const tTVPRect &ref) {
        // Clip (take the intersection of) the rectangle with
        // rectangle. returns whether the rectangle remains.
        return TVPIntersectRect(this, *this, ref);
    }
#endif
    bool intersects_with_no_empty_check(const tTVPRect &ref) const {
        // returns wether this has intersection with "ref"
        return !(left >= ref.right || top >= ref.bottom || right <= ref.left ||
                 bottom <= ref.top);
    }

    bool intersects_with(const tTVPRect &ref) const {
        // returns wether this has intersection with "ref"
        if(ref.is_empty() || is_empty())
            return false;
        return intersects_with_no_empty_check(ref);
    }

    bool included_in_no_empty_check(const tTVPRect &ref) const {
        // returns wether this is included in "ref"
        return ref.left <= left && ref.top <= top && ref.right >= right &&
            ref.bottom >= bottom;
    }

    bool included_in(const tTVPRect &ref) const {
        // returns wether this is included in "ref"
        if(ref.is_empty() || is_empty())
            return false;
        return included_in_no_empty_check(ref);
    }

public: // comparison operators for sorting
    bool operator<(const tTVPRect &rhs) const {
        return top < rhs.top || (top == rhs.top && left < rhs.left);
    }
    bool operator>(const tTVPRect &rhs) const {
        return top > rhs.top || (top == rhs.top && left > rhs.left);
    }

    // comparison methods
    bool operator==(const tTVPRect &rhs) const {
        return top == rhs.top && left == rhs.left && right == rhs.right &&
            bottom == rhs.bottom;
    }
    bool operator!=(const tTVPRect &rhs) const {
        return !this->operator==(rhs);
    }
};
//---------------------------------------------------------------------------

/*]*/

//---------------------------------------------------------------------------

#endif
