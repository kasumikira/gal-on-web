// kirikiroid2.cpp: the platform plugin adds the global _str_ord and attaches
// Storages.setTextEncoding. The latter already exists as a Storages method in
// this port (storage.js setTextEncoding + the TextStreamDecoder default), so only
// _str_ord is registered here.
export function registerKirikiroid2({ registerGlobal }) {
  // NCB_REGISTER_FUNCTION(_str_ord): a string yields its first UTF-16 code unit
  // (0 for the empty string); any other value is returned unchanged.
  registerGlobal('_str_ord', function _str_ord(value) {
    if (!arguments.length) throw new Error('TJS _str_ord requires a value');
    return typeof value === 'string' ? (value.length ? value.charCodeAt(0) : 0) : value;
  });
}
