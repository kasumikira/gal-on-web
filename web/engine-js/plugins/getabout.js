// getabout.cpp: NCB_ATTACH_FUNCTION(getAboutString, System, TVPGetAboutString).
// TVPGetAboutString patches the engine/TJS versions into the about resource and
// appends the important log (MsgIntf.cpp 146). The browser build has no about
// resource and no Windows log, so the runtime version text stands in for it; the
// scripts only scan the result for "! (info) ..." lines and fall back when none
// are present (system/movieqsel.tjs).
export function aboutString(System) {
  return String(System.versionInformation ?? '');
}

export function registerGetAbout({ get, registerMembers }) {
  const System = get('System');
  registerMembers(System, { getAboutString: () => aboutString(System) });
}
