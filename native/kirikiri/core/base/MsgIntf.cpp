#include "MsgIntf.h"
ttstr TVPFormatMessage(const tjs_char *msg, const ttstr &p1) {
    tjs_char *p;
    auto *buf = new tjs_char[TJS_strlen(msg) + p1.GetLen() + 1];
    p = buf;
    for(; *msg; msg++, p++) {
        if(*msg == TJS_W('%')) {
            if(msg[1] == TJS_W('%')) {
                // %%
                *p = TJS_W('%');
                msg++;
                continue;
            } else if(msg[1] == TJS_W('1')) {
                // %1
                TJS_strcpy(p, p1.c_str());
                p += p1.GetLen();
                p--;
                msg++;
                continue;
            }
        }
        *p = *msg;
    }

    *p = 0;

    ttstr ret(buf);
    delete[] buf;
    return ret;
}

ttstr TVPFormatMessage(const tjs_char *msg, const ttstr &p1, const ttstr &p2) {
    tjs_char *p;
    auto *buf = new tjs_char[TJS_strlen(msg) + p1.GetLen() + p2.GetLen() + 1];
    p = buf;
    for(; *msg; msg++, p++) {
        if(*msg == TJS_W('%')) {
            if(msg[1] == TJS_W('%')) {
                // %%
                *p = TJS_W('%');
                msg++;
                continue;
            } else if(msg[1] == TJS_W('1')) {
                // %1
                TJS_strcpy(p, p1.c_str());
                p += p1.GetLen();
                p--;
                msg++;
                continue;
            } else if(msg[1] == TJS_W('2')) {
                // %2
                TJS_strcpy(p, p2.c_str());
                p += p2.GetLen();
                p--;
                msg++;
                continue;
            }
        }
        *p = *msg;
    }

    *p = 0;

    ttstr ret(buf);
    delete[] buf;
    return ret;
}

