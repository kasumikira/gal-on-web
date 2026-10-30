if(NOT VCPKG_HOST_IS_WINDOWS)
    set(VCPKG_POLICY_EMPTY_PACKAGE enabled)
    return()
endif()

vcpkg_download_distfile(ARCHIVE
    URLS "https://github.com/lexxmark/winflexbison/releases/download/v${VERSION}/win_flex_bison-${VERSION}.zip"
    FILENAME "win_flex_bison-${VERSION}.zip"
    SHA512 2a829eb05003178c89f891dd0a67add360c112e74821ff28e38feb61dac5b66e9d3d5636ff9eef055616aaf282ee8d6be9f14c6ae4577f60bdcec96cec9f364e
)
vcpkg_extract_source_archive(SOURCE_PATH ARCHIVE "${ARCHIVE}" NO_REMOVE_ONE_LEVEL)
file(INSTALL "${SOURCE_PATH}/win_bison.exe" DESTINATION "${CURRENT_PACKAGES_DIR}/tools/bison/bin")
file(INSTALL "${SOURCE_PATH}/data" DESTINATION "${CURRENT_PACKAGES_DIR}/tools/bison/bin")
set(VCPKG_POLICY_SKIP_COPYRIGHT_CHECK enabled)
