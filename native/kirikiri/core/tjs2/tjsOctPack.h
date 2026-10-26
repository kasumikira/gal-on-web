//---------------------------------------------------------------------------
/*
        TJS2 Script Engine
        Copyright (C) 2013 T.Imoto and contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------

#ifndef tjsOctPackH
#define tjsOctPackH

#include "tjsArray.h"

namespace TJS {
    extern tjs_error TJSOctetPack(tTJSVariant **args, tjs_int numargs,
                                  const tTJSArrayItems &items,
                                  tTJSVariant *result);

    extern tjs_error TJSOctetUnpack(const tTJSVariantOctet *target,
                                    tTJSVariant **args, tjs_int numargs,
                                    tTJSVariant *result);
} // namespace TJS

#endif // tjsOctPackH
