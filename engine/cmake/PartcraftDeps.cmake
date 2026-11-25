# Third-party targets of the engine, built from the sources in PARTCRAFT_DEPS_DIR. Every folder must carry the
# ".partcraft-pin" stamp written by scripts/fetch-deps.*, and the stamp must match the pin in
# third_party/manifest.json, so a stale checkout stops the configure step instead of building silently.
#
# Targets: pc::json (nlohmann/json), pc::doctest, pc::eigen, pc::boost, pc::planegcs (static library).
# Variables: PC_PLANEGCS_SOURCE ("FreeCAD 1.1.4"), PC_PLANEGCS_COMMIT.

if(NOT EXISTS "${PC_MANIFEST}")
    message(FATAL_ERROR "third_party/manifest.json not found at ${PC_MANIFEST}")
endif()
file(READ "${PC_MANIFEST}" _pc_manifest)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${PC_MANIFEST}")

# Looks up component <id> in the manifest; sets <prefix>_DIR (fetch folder), <prefix>_VERSION, <prefix>_PIN (commit
# or SHA-256 values that the stamp must contain) and checks the stamp.
function(pc_dependency id prefix)
    string(JSON _count LENGTH "${_pc_manifest}" components)
    math(EXPR _last "${_count} - 1")
    foreach(_i RANGE ${_last})
        string(JSON _id GET "${_pc_manifest}" components ${_i} id)
        if(_id STREQUAL id)
            string(JSON _version GET "${_pc_manifest}" components ${_i} version)
            string(JSON _kind GET "${_pc_manifest}" components ${_i} fetch kind)
            string(JSON _dir GET "${_pc_manifest}" components ${_i} fetch dir)
            set(_pins "")
            if(_kind STREQUAL "git")
                string(JSON _pins GET "${_pc_manifest}" components ${_i} fetch commit)
            elseif(_kind STREQUAL "archive")
                string(JSON _pins GET "${_pc_manifest}" components ${_i} fetch sha256)
            elseif(_kind STREQUAL "files")
                string(JSON _nf LENGTH "${_pc_manifest}" components ${_i} fetch files)
                math(EXPR _lf "${_nf} - 1")
                foreach(_k RANGE ${_lf})
                    string(JSON _s GET "${_pc_manifest}" components ${_i} fetch files ${_k} sha256)
                    list(APPEND _pins "${_s}")
                endforeach()
            endif()
            set(_path "${PARTCRAFT_DEPS_DIR}/${_dir}")
            set(_stamp "${_path}/.partcraft-pin")
            if(NOT EXISTS "${_stamp}")
                message(FATAL_ERROR "Dependency ${id} ${_version} is missing in ${_path}. Run engine/scripts/fetch-deps.ps1 (Windows) or engine/scripts/fetch-deps.sh (Linux) first.")
            endif()
            file(READ "${_stamp}" _have)
            foreach(_p IN LISTS _pins)
                string(FIND "${_have}" "${_p}" _pos)
                if(_pos EQUAL -1)
                    message(FATAL_ERROR "Dependency ${id} in ${_path} does not match the pin ${_p} of third_party/manifest.json. Delete the folder and run the fetch script again.")
                endif()
            endforeach()
            set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_stamp}")
            set(${prefix}_DIR "${_path}" PARENT_SCOPE)
            set(${prefix}_VERSION "${_version}" PARENT_SCOPE)
            set(${prefix}_PIN "${_pins}" PARENT_SCOPE)
            return()
        endif()
    endforeach()
    message(FATAL_ERROR "Component ${id} is not listed in ${PC_MANIFEST}")
endfunction()

pc_dependency(nlohmann-json PC_JSON)
pc_dependency(eigen PC_EIGEN)
pc_dependency(boost PC_BOOST)
pc_dependency(planegcs PC_PLANEGCS)
set(PC_PLANEGCS_SOURCE "${PC_PLANEGCS_VERSION}")
set(PC_PLANEGCS_COMMIT "${PC_PLANEGCS_PIN}")

add_library(pc_json INTERFACE)
target_include_directories(pc_json SYSTEM INTERFACE "${PC_JSON_DIR}/include")
add_library(pc::json ALIAS pc_json)

add_library(pc_eigen INTERFACE)
target_include_directories(pc_eigen SYSTEM INTERFACE "${PC_EIGEN_DIR}")
# Compile error if any LGPL-licensed part of Eigen is used; only the MPL-2.0 parts (plus one Apache-2.0 and one
# BSD-3-Clause header) may be built in.
target_compile_definitions(pc_eigen INTERFACE EIGEN_MPL2_ONLY)
add_library(pc::eigen ALIAS pc_eigen)

add_library(pc_boost INTERFACE)
target_include_directories(pc_boost SYSTEM INTERFACE "${PC_BOOST_DIR}")
add_library(pc::boost ALIAS pc_boost)

if(PARTCRAFT_BUILD_TESTS AND NOT EMSCRIPTEN)
    pc_dependency(doctest PC_DOCTEST)
    add_library(pc_doctest INTERFACE)
    target_include_directories(pc_doctest SYSTEM INTERFACE "${PC_DOCTEST_DIR}/include")
    add_library(pc::doctest ALIAS pc_doctest)
endif()

# planegcs: FreeCAD's sketch solver, compiled unchanged from the fetched sources. The shim folder must come first
# for planegcs' own files: it replaces FreeCAD's FCConfig.h (which stops with #error on Emscripten), Base/Console.h
# and the generated QtCore.h. Consumers see every planegcs include folder as SYSTEM.
set(_pc_planegcs_src "${PC_PLANEGCS_DIR}/src/Mod/Sketcher/App/planegcs")
set(_pc_planegcs_shim "${CMAKE_CURRENT_SOURCE_DIR}/third_party_shims/planegcs")
add_library(pc_planegcs STATIC
    "${_pc_planegcs_src}/GCS.cpp"
    "${_pc_planegcs_src}/Constraints.cpp"
    "${_pc_planegcs_src}/Geo.cpp"
    "${_pc_planegcs_src}/SubSystem.cpp"
    "${_pc_planegcs_src}/qp_eq.cpp")
target_include_directories(pc_planegcs BEFORE PRIVATE "${_pc_planegcs_shim}" "${_pc_planegcs_src}" "${PC_PLANEGCS_DIR}/src")
target_include_directories(pc_planegcs SYSTEM INTERFACE "${_pc_planegcs_shim}" "${_pc_planegcs_src}" "${PC_PLANEGCS_DIR}/src")
target_link_libraries(pc_planegcs PUBLIC pc::eigen pc::boost)
# SketcherExport empty: a plain static library instead of __declspec(dllimport) on Windows.
target_compile_definitions(pc_planegcs PUBLIC SketcherExport=)
if(MSVC)
    target_compile_options(pc_planegcs PRIVATE /bigobj /utf-8 /w /EHsc)
else()
    target_compile_options(pc_planegcs PRIVATE -w)
endif()
if(EMSCRIPTEN)
    target_compile_options(pc_planegcs PRIVATE -fwasm-exceptions)
else()
    # System::diagnose starts std::async; under Emscripten (no threads) libc++ falls back to deferred execution.
    find_package(Threads REQUIRED)
    target_link_libraries(pc_planegcs PUBLIC Threads::Threads)
endif()
add_library(pc::planegcs ALIAS pc_planegcs)
