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
