#pragma once
#include "tjs.h"
#include <cstring>
#include <stdexcept>
#include <vector>
class MemoryOutput final : public TJS::tTJSBinaryStream
{
  public:
    std::vector<unsigned char> bytes;
    size_t position = 0;
    tjs_uint64 Seek(tjs_int64 offset, tjs_int whence) override
    {
        const tjs_int64 base = whence == SEEK_SET   ? 0
                               : whence == SEEK_CUR ? position
                               : whence == SEEK_END ? bytes.size()
                                                    : -1;
        if (base < 0 || base + offset < 0)
            throw std::runtime_error("Invalid compiler output seek");
        position = static_cast<size_t>(base + offset);
        return position;
    }
    tjs_uint Read(void *, tjs_uint) override
    {
        throw std::runtime_error("Compiler output stream is write-only");
    }
    tjs_uint Write(const void *data, tjs_uint size) override
    {
        if (position + size > bytes.size())
            bytes.resize(position + size);
        std::memcpy(bytes.data() + position, data, size);
        position += size;
        return size;
    }
    tjs_uint64 GetSize() override
    {
        return bytes.size();
    }
    void SetEndOfStorage() override
    {
        bytes.resize(position);
    }
};
