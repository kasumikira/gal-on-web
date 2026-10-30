cmake_minimum_required(VERSION 3.28)
if(CMAKE_HOST_WIN32 AND NOT DEFINED VCPKG_HOST_TRIPLET)
    if("$ENV{PROCESSOR_ARCHITECTURE}" STREQUAL "ARM64")
        set(VCPKG_HOST_TRIPLET arm64-windows CACHE STRING "vcpkg host triplet")
    else()
        set(VCPKG_HOST_TRIPLET x64-windows CACHE STRING "vcpkg host triplet")
    endif()
endif()
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
find_package(libgdiplus CONFIG REQUIRED)
add_compile_options(-fwasm-exceptions)
add_subdirectory(core/tjs2)
target_include_directories(tjs2 PRIVATE "${CMAKE_CURRENT_LIST_DIR}/core/common")

add_executable(tjs-runtime runtime.cpp
    runtime-api.cpp
    runtime-host.cpp
    runtime-layer.cpp
    runtime-visual.cpp
    render/gles.cpp
    render/render-texture.cpp
    render/render-device.cpp
    render/render-api.cpp
    render/bitmap-surface.cpp
    visual/PrerenderedFont.cpp
    font/font-api.cpp
    visual/NativeTexture.cpp
    visual/NativeRenderManager.cpp
    visual/RenderMethods.cpp
    visual/RenderImage.cpp
    visual/FontImpl.cpp
    visual/FontSystem.cpp
    visual/FreeType.cpp
    visual/FreeTypeFontRasterizer.cpp
    visual/CharacterData.cpp
    visual/argb.cpp
    visual/BitmapInfomation.cpp
    visual/LayerBitmapImpl.cpp
    visual/LayerBitmapIntf.cpp
    visual/VisualPlatform.cpp
    visual/TVPColor.cpp
    visual/LayerIntf.cpp
    visual/LayerImpl.cpp
    visual/LayerManager.cpp
    visual/LayerTreeOwnerImpl.cpp
    visual/BrowserWindow.cpp
    visual/TransIntf.cpp
    visual/BitmapIntf.cpp
    visual/GraphicsLoaderIntf.cpp
    visual/GraphicsLoaderImpl.cpp
    visual/EventIntf.cpp
    core/base/SystemIntf.cpp
    core/base/SystemPlatform.cpp
    image/image-loader.cpp
    image/image-api.cpp
    image/load-png.cpp
    image/load-jpeg.cpp
    image/load-tlg.cpp
    image/load-webp.cpp
    visual/tvpgl.cpp
    visual/gl/blend_function.cpp
    visual/gl/ResampleImage.cpp
    visual/gl/WeightFunctor.cpp
    visual/gl/imagepacker.cpp
    visual/PixelInit.cpp
    core/plugin/PluginRegistry.cpp
    runtime-platform.cpp
    core/base/TextStream.cpp
    core/utils/encoding/jis2unicode.c
    core/utils/encoding/gbk2unicode.c
    core/base/StorageIntf.cpp
    core/base/TimerIntf.cpp
    core/base/RectItf.cpp
    core/base/RectMath.cpp
    core/base/MsgIntf.cpp
    core/base/PadIntf.cpp
    core/base/MenuItemIntf.cpp
    core/base/KAGParser.cpp
    core/base/ScriptMgnIntf.cpp
    plugins/dirlist.cpp
    plugins/fstat.cpp
    plugins/xp3filter.cpp
    plugins/BinaryAccessor.cpp
    plugins/extrans/Extrans.cpp
    plugins/extrans/turntrans_table.cpp
    plugins/kagparserex/KAGParser.cpp
    plugins/csvParser.cpp
    plugins/saveStruct.cpp
    plugins/scriptsEx.cpp
    plugins/shrinkCopy.cpp
    plugins/layerExBTOA.cpp
    plugins/layerExRaster.cpp
    plugins/layerex_draw/main.cpp
    plugins/layerex_draw/LayerExDraw.cpp
    plugins/layerex_draw/DrawPath.cpp
    plugins/kirikiroid2.cpp
    plugins/json/JSON.cpp
    plugins/expat/XMLParser.cpp
    plugins/textrender/TextRender.cpp
    plugins/psbfile/PSBFile.cpp
    plugins/psbfile/PSBRawFile.cpp
    core/utils/md5.c
)
target_include_directories(tjs-runtime PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}" core/base core/plugin core/utils core/common image visual)
file(GLOB MOTION_SOURCES CONFIGURE_DEPENDS plugins/motionplayer/*.cpp)
target_sources(tjs-runtime PRIVATE ${MOTION_SOURCES})
target_include_directories(tjs-runtime PRIVATE plugins "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/include/glib-2.0" "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/lib/glib-2.0/include")
target_link_libraries(tjs-runtime PRIVATE tjs2 ZLIB::ZLIB expat::expat libgdiplus::libgdiplus)
target_compile_options(tjs-runtime PRIVATE -fwasm-exceptions -msimd128 -sUSE_FREETYPE=1 --use-port=contrib.libwebp)
set_target_properties(tjs-runtime PROPERTIES SUFFIX ".js")
target_link_options(tjs-runtime PRIVATE --no-entry -fwasm-exceptions -g2 --emit-symbol-map
  "-sMIN_WEBGL_VERSION=2" "-sMAX_WEBGL_VERSION=2" "-sGL_PREINITIALIZED_CONTEXT=1"
  "-sMODULARIZE=1" "-sEXPORT_ES6=1" "-sENVIRONMENT=node,web"
  "-sALLOW_MEMORY_GROWTH=1" "-sJSPI=1"
  "-sUSE_LIBPNG=1" "-sUSE_LIBJPEG=1" "-sUSE_FREETYPE=1"
  "--use-port=contrib.libwebp"
  "-sJSPI_IMPORTS=['host_call']"
  "-sJSPI_EXPORTS=['tjs_execute_source','tjs_execute_bytecode','tjs_object_get','tjs_object_get_raw','tjs_object_set','tjs_object_call','tjs_object_clone','tjs_object_construct','tjs_object_invalidate','tjs_runtime_shutdown','tjs_runtime_destroy','tjs_value_release_async','tjs_runtime_compact','tjs_borrow_end','tjs_window_objects','tjs_plugins','tjs_layer_font','tjs_visual_register','tjs_visual_events','tjs_visual_window','tjs_visual_bitmap','tjs_visual_movie_frame','tjs_touch_images','tjs_system_initialize','tjs_system_maintain']"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_tjs_graphic_cache_limit','_tjs_graphic_cache_system_limit','_tjs_clear_graphic_cache','_tjs_touch_images','_gal_render_initialize','_gal_render_shutdown','_gal_render_resize','_gal_render_max_texture','_gal_render_texture_create','_gal_render_texture_from_pixels','_gal_render_texture_release','_gal_render_texture_share','_gal_render_texture_clone','_gal_render_texture_writable','_gal_render_texture_width','_gal_render_texture_height','_gal_render_texture_independent','_gal_render_texture_update','_gal_render_texture_read','_gal_render_texture_fill','_gal_render_texture_clear','_gal_render_clear','_gal_render_present','_gal_render_copy','_gal_render_scale','_gal_render_draw_rect','_gal_render_draw_quad','_gal_render_read_canvas','_gal_render_draw_count','_gal_render_last_error','_gal_render_context_lost','_gal_render_context_restored','_gal_bitmap_create','_gal_bitmap_decode','_gal_bitmap_resize','_gal_bitmap_from_pixels','_gal_bitmap_share','_gal_bitmap_release','_gal_bitmap_width','_gal_bitmap_height','_gal_bitmap_fill','_gal_bitmap_copy','_gal_bitmap_draw','_gal_bitmap_read','_gal_font_open','_gal_font_release','_gal_font_glyph_metrics','_gal_font_glyph_read','_gal_font_last_error','_gal_image_decode','_gal_image_width','_gal_image_height','_gal_image_channels','_gal_image_pixels','_gal_image_release','_gal_image_last_error']"
  "-sEXPORTED_RUNTIME_METHODS=['stringToUTF16','UTF16ToString','HEAPU8','HEAPU32']")
