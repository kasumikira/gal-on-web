cmake_minimum_required(VERSION 3.28)
project(gal_kirikiri LANGUAGES C CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure with the Emscripten toolchain")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
find_program(BISON_EXECUTABLE NAMES win_bison.exe bison.exe bison REQUIRED)
find_package(Python3 COMPONENTS Interpreter REQUIRED)
find_package(ZLIB REQUIRED)
find_package(expat CONFIG REQUIRED)
add_compile_options(-fwasm-exceptions)
add_subdirectory(core/tjs2)
target_include_directories(tjs2 PRIVATE "${CMAKE_CURRENT_LIST_DIR}/core/common")

add_executable(tjs-runtime runtime.cpp
    runtime-api.cpp
    runtime-host.cpp
    core/plugin/PluginRegistry.cpp
    runtime-platform.cpp
    core/base/TextStream.cpp
    core/utils/encoding/jis2unicode.c
    core/utils/encoding/gbk2unicode.c
    core/base/StoragesIntf.cpp
    core/base/TimerIntf.cpp
    core/base/RectItf.cpp
    core/base/RectMath.cpp
    core/base/PadIntf.cpp
    core/base/MenuItemIntf.cpp
    core/base/KAGParser.cpp
    core/base/ScriptMgnIntf.cpp
    plugins/dirlist.cpp
    plugins/fstat.cpp
    plugins/xp3filter.cpp
    plugins/BinaryAccessor.cpp
    plugins/csvParser.cpp
    plugins/saveStruct.cpp
    plugins/scriptsEx.cpp
    plugins/kirikiroid2.cpp
    plugins/json/JSON.cpp
    plugins/expat/XMLParser.cpp
    plugins/textrender/TextRender.cpp
    plugins/psbfile/PSBFile.cpp
    plugins/psbfile/PSBRawFile.cpp
    core/utils/md5.c
)
target_include_directories(tjs-runtime PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}" core/base core/plugin core/utils core/common)
target_link_libraries(tjs-runtime PRIVATE tjs2 ZLIB::ZLIB expat::expat)
target_compile_options(tjs-runtime PRIVATE -fwasm-exceptions)
set_target_properties(tjs-runtime PROPERTIES SUFFIX ".js")
target_link_options(tjs-runtime PRIVATE --no-entry -fwasm-exceptions -g2 --emit-symbol-map
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=node,web"
  "-sALLOW_MEMORY_GROWTH=1" "-sJSPI=1"
  "-sJSPI_IMPORTS=['host_call']"
  "-sJSPI_EXPORTS=['tjs_execute_source','tjs_execute_bytecode','tjs_object_get','tjs_object_get_raw','tjs_object_set','tjs_object_call','tjs_object_clone','tjs_object_construct','tjs_object_invalidate','tjs_runtime_shutdown','tjs_runtime_destroy','tjs_value_release_async','tjs_runtime_collect','tjs_borrow_end','tjs_window_objects','tjs_plugins']"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free']"
  "-sEXPORTED_RUNTIME_METHODS=['stringToUTF16','UTF16ToString','HEAPU8','HEAPU32']")
