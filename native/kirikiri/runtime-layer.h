#pragma once
#include "tjs.h"
using namespace TJS;
struct Runtime;

// Layer field indices match LAYER_FIELDS in native.js. Rendering fields are
// stored in the JS Node; the remaining fields are native state.
enum NativeLayerField : int {
    lfLeft, lfTop, lfImageLeft, lfImageTop, lfOpacity, lfVisible, lfEnabled,
    lfAbsoluteOrderMode, lfAbsoluteOrderIndex, lfIsPrimary,
    lfType, lfDisplayType, lfFace, lfDrawFace, lfHoldAlpha,
    lfHitType, lfHitThreshold, lfAttentionLeft, lfAttentionTop, lfUseAttention,
    lfFocusable, lfJoinFocusChain, lfImeMode, lfCursor, lfCursorX, lfCursorY,
    lfCount
};

// Derived property identifiers follow the scalar property identifiers.
enum NativeLayerRelation : int {
    lrParent = lfCount, lrChildren, lrOrder, lrAbsolute,
    lrNodeVisible, lrNodeEnabled, lrFont
};

// Only script object identity and ownership remain native. All Layer/Font
// business data, including the tree, lives in JS.
struct NativeLayerState {
    Runtime *runtime;
    iTJSDispatch2 *owner = nullptr;
    tTJSVariant fontObject, childrenArray, childrenClear;
    explicit NativeLayerState(Runtime *r) : runtime(r) {}
    iTJSDispatch2 *getChildren(const tTJSVariant &snapshot);
    iTJSDispatch2 *getFont();
    void invalidateFont();
};
