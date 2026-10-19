# Public C ABI headers only; the runtime is explicitly loaded by active effects.
set(triscord_ort_headers "${CMAKE_BINARY_DIR}/_deps/ort-headers")
file(MAKE_DIRECTORY "${triscord_ort_headers}")
set(triscord_ort_files onnxruntime_c_api.h onnxruntime_ep_c_api.h onnxruntime_error_code.h)
set(triscord_ort_hashes
  43d584f596ef66820421317df32a79a95fc1d39ee46cb3971a870c08d8ba4baa
  b64036772115dbc6f06a900487ce22d34e862100db03e2ad62210758e27a19b2
  5ce3b054e798eced8d14f5b86e98692fd33470463f96194ce0700a2d53dd8721)
foreach(index RANGE 0 2)
  list(GET triscord_ort_files ${index} ort_file)
  list(GET triscord_ort_hashes ${index} ort_hash)
  if(NOT EXISTS "${triscord_ort_headers}/${ort_file}")
    file(DOWNLOAD "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.0/include/onnxruntime/core/session/${ort_file}"
      "${triscord_ort_headers}/${ort_file}" EXPECTED_HASH "SHA256=${ort_hash}" TLS_VERIFY ON)
  endif()
  file(SHA256 "${triscord_ort_headers}/${ort_file}" ort_actual)
  if(NOT ort_actual STREQUAL ort_hash)
    message(FATAL_ERROR "ONNX Runtime header integrity mismatch: ${ort_file}")
  endif()
endforeach()
configure_file("${CMAKE_CURRENT_LIST_DIR}/../assets/media-licenses/OnnxRuntime-MIT.txt"
  "${CMAKE_BINARY_DIR}/media-licenses/OnnxRuntime-MIT.txt" COPYONLY)
add_library(triscord_camera_effects STATIC src/camera_segmenter.cpp src/camera_segmenter.h src/camera_mask.cpp src/camera_mask.h)
target_sources(triscord_camera_effects PRIVATE src/camera_composite.cpp src/camera_composite.h)
target_include_directories(triscord_camera_effects PUBLIC src PRIVATE "${triscord_ort_headers}")
target_link_libraries(triscord_camera_effects PUBLIC Qt6::Gui)
target_link_libraries(triscord_camera_effects PRIVATE d3d11 d3dcompiler)
target_compile_definitions(triscord_camera_effects PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
