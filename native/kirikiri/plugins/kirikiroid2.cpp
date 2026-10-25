// kirikiroid2.dll: the script-value helper runs inside TJS. The existing
// Storages.setTextEncoding delegates to the native TextStream converter.
#include "ncbind.hpp"
#define NCB_MODULE_NAME TJS_W("kirikiroid2.dll")

static tjs_error krkr_str_ord(tTJSVariant *result, tjs_int numparams,
                            tTJSVariant **param, iTJSDispatch2 *) {
    if (numparams == 0) return TJS_E_FAIL;
    tTJSVariant value = *param[0];
    if (result) {
        if (value.Type() == tvtString)
            // Use the string accessor rather than the reference's ShortString
            // field so long strings retain the existing first-code-unit behavior.
            *result = static_cast<tjs_int>(value.GetString()[0]);
        else
            *result = value;
    }
    return TJS_S_OK;
}

NCB_REGISTER_FUNCTION(_str_ord, krkr_str_ord);
