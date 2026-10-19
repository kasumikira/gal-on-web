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
add_compile_options(-fwasm-exceptions)
add_subdirectory(core/tjs2)
target_include_directories(tjs2 PRIVATE "${CMAKE_CURRENT_LIST_DIR}/core/common")

add_executable(tjs-runtime runtime.cpp
    runtime-api.cpp
    runtime-host.cpp
    runtime-platform.cpp
    core/base/KAGParser.cpp
    core/base/ScriptMgnIntf.cpp
    plugins/scriptsEx.cpp
    core/utils/md5.c
)
target_include_directories(tjs-runtime PRIVATE core/base core/utils core/common)
target_link_libraries(tjs-runtime PRIVATE tjs2)
target_compile_options(tjs-runtime PRIVATE -fwasm-exceptions)
set_target_properties(tjs-runtime PROPERTIES SUFFIX ".js")
target_link_options(tjs-runtime PRIVATE --no-entry -fwasm-exceptions -g2 --emit-symbol-map
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=node,web"
  "-sALLOW_MEMORY_GROWTH=1" "-sJSPI=1"
  "-sJSPI_IMPORTS=['__asyncjs__host_call']"
  "-sJSPI_EXPORTS=['tjs_execute_source','tjs_execute_bytecode','tjs_object_get','tjs_object_set','tjs_object_call','tjs_object_clone','tjs_object_construct','tjs_object_invalidate','tjs_runtime_shutdown','tjs_runtime_destroy','tjs_value_release_async','tjs_runtime_collect','tjs_borrow_end','tjs_window_objects']"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free']"
  "-sEXPORTED_RUNTIME_METHODS=['stringToUTF16','UTF16ToString','HEAPU8','HEAPU32']")

