use crate::{
    pixels::{bgra_to_rgba_in_place, decode_rl32, decode_rl8},
    png::decode_png_indexed,
    tlg::{decode_tlg_into, dimensions},
    DecodeError,
};
#[unsafe(no_mangle)]
pub extern "C" fn codecs_alloc(len: usize) -> *mut u8 {
    let boxed = vec![0u8; len.max(1)].into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        let s = core::ptr::slice_from_raw_parts_mut(ptr, len.max(1));
        drop(Box::from_raw(s));
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_dimensions(ptr: *const u8, len: usize) -> u64 {
    let data = core::slice::from_raw_parts(ptr, len);
    match dimensions(data) {
        Ok((w, h)) => (h as u64) << 32 | w as u64,
        Err(_) => 0,
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_decode_png_indexed(
    ptr: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
    province: u32,
    key: u32,
) -> i32 {
    let data = core::slice::from_raw_parts(ptr, len);
    let output = core::slice::from_raw_parts_mut(out, out_len);
    decode_png_indexed(data, output, province != 0, key)
        .err()
        .unwrap_or(0)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_decode_tlg(
    ptr: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
) -> i32 {
    let data = core::slice::from_raw_parts(ptr, len);
    match decode_tlg_into(data, core::slice::from_raw_parts_mut(out, out_len)) {
        Ok(_) => 0,
        Err(DecodeError::Output) => 2,
        Err(DecodeError::Invalid) => 1,
        Err(DecodeError::Unsupported) => 3,
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_decode_rl8(
    src: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
    simd: u32,
) -> usize {
    decode_rl8(
        core::slice::from_raw_parts(src, len),
        core::slice::from_raw_parts_mut(out, out_len),
        simd != 0,
    )
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_decode_rl32(
    src: *const u8,
    len: usize,
    out: *mut u8,
    out_len: usize,
    simd: u32,
) -> usize {
    decode_rl32(
        core::slice::from_raw_parts(src, len),
        core::slice::from_raw_parts_mut(out, out_len),
        simd != 0,
    )
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codecs_bgra_to_rgba_in_place(
    ptr: *mut u8,
    len: usize,
    simd: u32,
) -> usize {
    bgra_to_rgba_in_place(core::slice::from_raw_parts_mut(ptr, len), simd != 0)
}
