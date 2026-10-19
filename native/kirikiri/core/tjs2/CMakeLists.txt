cmake_minimum_required(VERSION 3.28)

add_library(tjs2 STATIC)
target_compile_definitions(tjs2 PRIVATE $<$<CONFIG:Debug>:_DEBUG>)

set(GEN_CODE_BINARY_DIR ${CMAKE_CURRENT_BINARY_DIR}/gen)

if(WINDOWS)
    target_compile_options(tjs2 PRIVATE "/FS")
endif()

if(NOT EXISTS ${GEN_CODE_BINARY_DIR})
    file(MAKE_DIRECTORY ${GEN_CODE_BINARY_DIR})
endif()

#===============================================================#
#======================= generate parser =======================#
#===============================================================#
find_program(BISON_EXECUTABLE NAMES win_bison.exe bison.exe bison)

set(BISON_FILES
    ${CMAKE_CURRENT_LIST_DIR}/bison/tjs.y
    ${CMAKE_CURRENT_LIST_DIR}/bison/tjsdate.y
    ${CMAKE_CURRENT_LIST_DIR}/bison/tjspp.y
)
set(PARSE_TAB_CPP_FILES)
foreach(BISON_FILE ${BISON_FILES})
    get_filename_component(FILE_NAME ${BISON_FILE} NAME_WE)

    add_custom_command(
        OUTPUT
            ${GEN_CODE_BINARY_DIR}/${FILE_NAME}.tab.cpp
            ${GEN_CODE_BINARY_DIR}/${FILE_NAME}.tab.hpp
        DEPENDS ${BISON_FILE}
        COMMAND ${BISON_EXECUTABLE} ${BISON_FILE}
        WORKING_DIRECTORY ${GEN_CODE_BINARY_DIR}
        COMMENT "Generate Bison File From ${BISON_FILE}"
        VERBATIM
    )

    list(APPEND PARSE_TAB_CPP_FILES ${GEN_CODE_BINARY_DIR}/${FILE_NAME}.tab.cpp)
endforeach()

add_custom_target(GENERATE_CPP_FILES DEPENDS ${PARSE_TAB_CPP_FILES})
add_dependencies(tjs2 GENERATE_CPP_FILES)

install(DIRECTORY "${GEN_CODE_BINARY_DIR}/"
    DESTINATION "include/tjs2/parser"
    FILES_MATCHING PATTERN "*.tab.hpp"
)

#===============================================================#
#==================== generate date word =======================#
#===============================================================#
find_package(Python3)

add_custom_command(
    OUTPUT "${GEN_CODE_BINARY_DIR}/tjsDateWordMap.inc"
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_LIST_DIR}/script/create_world_map.py" "${GEN_CODE_BINARY_DIR}/tjsDateWordMap.inc"
    DEPENDS "${CMAKE_CURRENT_LIST_DIR}/script/create_world_map.py" "${CMAKE_CURRENT_LIST_DIR}/script/dp_word_table.txt"
    WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/script"
    VERBATIM
)

target_sources(tjs2 PRIVATE
    ${PARSE_TAB_CPP_FILES}
    "${GEN_CODE_BINARY_DIR}/tjsDateWordMap.inc"
    tjsLex.cpp
    tjsNative.cpp
    tjsRandomGenerator.cpp
    tjsDebug.cpp
    tjsRegExp.cpp
    tjsBinarySerializer.cpp
    tjsInterCodeGen.cpp
    tjsObject.cpp
    tjsConstArrayData.cpp
    tjsUtils.cpp
    tjsException.cpp
    tjsDictionary.cpp
    tjsInterCodeExec.cpp
    tjsVariantString.cpp
    tjsScriptBlock.cpp
    tjsMath.cpp
    tjs.cpp
    tjsMessage.cpp
    tjsDisassemble.cpp
    tjsDate.cpp
    tjsError.cpp
    tjsInterface.cpp
    tjsMT19937ar-cok.cpp
    tjsArray.cpp
    tjsByteCodeLoader.cpp
    tjsDateParser.cpp
    tjsGlobalStringMap.cpp
    tjsOctPack.cpp
    tjsNamespace.cpp
    tjsScriptCache.cpp
    tjsConfig.cpp
    tjsCompileControl.cpp
    tjsObjectExtendable.cpp
    tjsVariant.cpp
    tjsString.cpp
)

install(DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/"
    DESTINATION "include/tjs2"
    FILES_MATCHING PATTERN "*.h"
)

target_include_directories(tjs2
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_LIST_DIR}>
        $<BUILD_INTERFACE:${GEN_CODE_BINARY_DIR}>
    INTERFACE
        $<INSTALL_INTERFACE:include/tjs2>
        $<INSTALL_INTERFACE:include/tjs2/parser>
)

find_package(Boost COMPONENTS locale REQUIRED NO_MODULE)
find_package(fmt CONFIG REQUIRED)
find_package(spdlog CONFIG REQUIRED)
find_package(oniguruma CONFIG REQUIRED)

target_link_libraries(tjs2 PUBLIC
    Boost::locale
    fmt::fmt
    spdlog::spdlog
    oniguruma::onig
)