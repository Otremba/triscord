include(FetchContent)
set(CMAKE_AUTOMOC OFF)
set(triscord_vendor_testing "${BUILD_TESTING}")
set(BUILD_TESTING OFF)
# Revisions are immutable. Codecs and WebRTC transport are native libraries,
# not a browser runtime. Never use the obsolete OpenSSL bundled with MinGW.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTING OFF CACHE BOOL "" FORCE)
set(ENABLE_PROGRAMS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(mbedtls GIT_REPOSITORY https://github.com/Mbed-TLS/mbedtls.git
  GIT_TAG e185d7fd85499c8ce5ca2a54f5cf8fe7dbe3f8df OVERRIDE_FIND_PACKAGE EXCLUDE_FROM_ALL)
FetchContent_MakeAvailable(mbedtls)
foreach(tls_target mbedtls mbedx509 mbedcrypto)
  target_compile_definitions(${tls_target} PUBLIC
    "MBEDTLS_USER_CONFIG_FILE=\"${CMAKE_CURRENT_LIST_DIR}/mbedtls_user_config.h\"")
endforeach()
if(NOT TARGET MbedTLS::MbedTLS)
  add_library(MbedTLS::MbedTLS INTERFACE IMPORTED)
  set_target_properties(MbedTLS::MbedTLS PROPERTIES INTERFACE_LINK_LIBRARIES "mbedtls;mbedx509;mbedcrypto")
endif()
file(WRITE "${CMAKE_FIND_PACKAGE_REDIRECTS_DIR}/mbedtls-extra.cmake"
  "set(MBEDTLS_INCLUDE_DIRS \"${mbedtls_SOURCE_DIR}/include\")\nset(MBEDTLS_LIBRARIES MbedTLS::MbedTLS)\nset(MbedTLS_FOUND TRUE)\n")
set(USE_MBEDTLS ON CACHE BOOL "" FORCE)
set(NO_WEBSOCKET ON CACHE BOOL "" FORCE)
set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
set(NO_TESTS ON CACHE BOOL "" FORCE)
set(NO_MEDIA OFF CACHE BOOL "" FORCE)
set(LIBSRTP_TEST_APPS OFF CACHE BOOL "" FORCE)
# Upstream libSRTP's Windows debug printf produces MinGW format warnings.
# Keep warnings visible without turning third-party warnings into build errors.
set(ENABLE_WARNINGS_AS_ERRORS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(rtc GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
  GIT_TAG 6b1e2e620f1e37f0eafeee702eaea0043cb305fd EXCLUDE_FROM_ALL)
FetchContent_MakeAvailable(rtc)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(opus GIT_REPOSITORY https://github.com/xiph/opus.git
  GIT_TAG ddbe48383984d56acd9e1ab6a090c54ca6b735a6 EXCLUDE_FROM_ALL)
FetchContent_MakeAvailable(opus)
FetchContent_Declare(speexdsp GIT_REPOSITORY https://github.com/xiph/speexdsp.git
  GIT_TAG 1b28a0f61bc31162979e1f26f3981fc3637095c8 EXCLUDE_FROM_ALL)
FetchContent_MakeAvailable(speexdsp)
# RNNoise (Xiph, BSD-3): neural noise suppression behind "Supressão de ruído", the free counterpart of Discord's Krisp.
# v0.1.1 keeps its trained model in the source (rnn_data.c) and already prefixes its DSP helpers (rnn_*), so it links
# next to libopus. A local copy in .toolchain/rnnoise is used when present.
if(NOT FETCHCONTENT_SOURCE_DIR_RNNOISE AND EXISTS "${CMAKE_CURRENT_LIST_DIR}/../../.toolchain/rnnoise/src/denoise.c")
  set(FETCHCONTENT_SOURCE_DIR_RNNOISE "${CMAKE_CURRENT_LIST_DIR}/../../.toolchain/rnnoise")
endif()
FetchContent_Declare(rnnoise GIT_REPOSITORY https://github.com/xiph/rnnoise.git
  GIT_TAG 6cbfd53eb348a8d394e0757b4025c6ded34eb2b6 EXCLUDE_FROM_ALL)   # v0.1.1
FetchContent_MakeAvailable(rnnoise)
add_library(triscord_rnnoise STATIC
  ${rnnoise_SOURCE_DIR}/src/denoise.c ${rnnoise_SOURCE_DIR}/src/rnn.c ${rnnoise_SOURCE_DIR}/src/rnn_data.c
  ${rnnoise_SOURCE_DIR}/src/pitch.c ${rnnoise_SOURCE_DIR}/src/kiss_fft.c ${rnnoise_SOURCE_DIR}/src/celt_lpc.c)
target_include_directories(triscord_rnnoise SYSTEM PUBLIC ${rnnoise_SOURCE_DIR}/include)
target_include_directories(triscord_rnnoise PRIVATE ${rnnoise_SOURCE_DIR}/src)
target_compile_definitions(triscord_rnnoise PRIVATE RNNOISE_BUILD)
if(NOT MSVC)
  target_compile_options(triscord_rnnoise PRIVATE -w)
endif()
# Upstream ships autotools/VS projects. Build only DSP, not codecs, examples or
# diagnostic dumps. This configuration uses its bundled floating-point FFT.
add_library(triscord_dsp STATIC
  ${speexdsp_SOURCE_DIR}/libspeexdsp/resample.c
  ${speexdsp_SOURCE_DIR}/libspeexdsp/preprocess.c
  ${speexdsp_SOURCE_DIR}/libspeexdsp/mdf.c
  ${speexdsp_SOURCE_DIR}/libspeexdsp/filterbank.c
  ${speexdsp_SOURCE_DIR}/libspeexdsp/fftwrap.c
  ${speexdsp_SOURCE_DIR}/libspeexdsp/kiss_fft.c
  ${speexdsp_SOURCE_DIR}/libspeexdsp/kiss_fftr.c)
target_include_directories(triscord_dsp SYSTEM PUBLIC ${speexdsp_SOURCE_DIR}/include)
target_compile_definitions(triscord_dsp PRIVATE FLOATING_POINT USE_KISS_FFT "EXPORT=")
if(MSVC)
  target_compile_definitions(triscord_dsp PRIVATE "inline=__inline")
endif()
set(triscord_media_notices "${CMAKE_BINARY_DIR}/media-licenses")
file(MAKE_DIRECTORY "${triscord_media_notices}")
configure_file("${CMAKE_CURRENT_LIST_DIR}/../assets/media-licenses/MediaPipe-Apache-2.0.txt"
  "${triscord_media_notices}/MediaPipe-Apache-2.0.txt" COPYONLY)
configure_file("${speexdsp_SOURCE_DIR}/COPYING" "${triscord_media_notices}/SpeexDSP-license.txt" COPYONLY)
configure_file("${rnnoise_SOURCE_DIR}/COPYING" "${triscord_media_notices}/RNNoise-license.txt" COPYONLY)
file(WRITE "${triscord_media_notices}/SpeexDSP-FFT-notices.txt" "")
foreach(fft_source kiss_fft.c kiss_fftr.c kiss_fft.h kiss_fftr.h _kiss_fft_guts.h)
  file(READ "${speexdsp_SOURCE_DIR}/libspeexdsp/${fft_source}" fft_text)
  string(FIND "${fft_text}" "*/" fft_notice_end)
  math(EXPR fft_notice_length "${fft_notice_end} + 2")
  string(SUBSTRING "${fft_text}" 0 ${fft_notice_length} fft_notice)
  file(APPEND "${triscord_media_notices}/SpeexDSP-FFT-notices.txt" "${fft_notice}\n\n")
endforeach()
configure_file("${rtc_SOURCE_DIR}/LICENSE" "${triscord_media_notices}/libdatachannel-MPL-2.0.txt" COPYONLY)
configure_file("${mbedtls_SOURCE_DIR}/LICENSE" "${triscord_media_notices}/MbedTLS-license.txt" COPYONLY)
configure_file("${opus_SOURCE_DIR}/COPYING" "${triscord_media_notices}/Opus-license.txt" COPYONLY)
configure_file("${opus_SOURCE_DIR}/LICENSE_PLEASE_READ.txt" "${triscord_media_notices}/Opus-additional-notices.txt" COPYONLY)
foreach(media_dep plog libjuice usrsctp libsrtp json)
  if(media_dep STREQUAL "usrsctp")
    set(media_license LICENSE.md)
  elseif(media_dep STREQUAL "json")
    set(media_license LICENSE.MIT)
  else()
    set(media_license LICENSE)
  endif()
  configure_file("${rtc_SOURCE_DIR}/deps/${media_dep}/${media_license}"
    "${triscord_media_notices}/${media_dep}-license.txt" COPYONLY)
endforeach()
set(CMAKE_AUTOMOC ON)
set(BUILD_TESTING "${triscord_vendor_testing}")
