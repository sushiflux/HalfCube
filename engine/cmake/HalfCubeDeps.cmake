# Third-party targets of the engine, built from the sources in HALFCUBE_DEPS_DIR. Every folder must carry the
# ".halfcube-pin" stamp written by scripts/fetch-deps.*, and the stamp must match the pin in
# third_party/manifest.json, so a stale checkout stops the configure step instead of building silently.
#
# Targets: hc::json (nlohmann/json), hc::doctest, hc::eigen, hc::boost, hc::planegcs (static library).
# Variables: HC_PLANEGCS_SOURCE ("FreeCAD 1.1.4"), HC_PLANEGCS_COMMIT.

if(NOT EXISTS "${HC_MANIFEST}")
    message(FATAL_ERROR "third_party/manifest.json not found at ${HC_MANIFEST}")
endif()
file(READ "${HC_MANIFEST}" _hc_manifest)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${HC_MANIFEST}")

# Looks up component <id> in the manifest; sets <prefix>_DIR (fetch folder), <prefix>_VERSION, <prefix>_PIN (commit
# or SHA-256 values that the stamp must contain) and checks the stamp.
function(hc_dependency id prefix)
    string(JSON _count LENGTH "${_hc_manifest}" components)
    math(EXPR _last "${_count} - 1")
    foreach(_i RANGE ${_last})
        string(JSON _id GET "${_hc_manifest}" components ${_i} id)
        if(_id STREQUAL id)
            string(JSON _version GET "${_hc_manifest}" components ${_i} version)
            string(JSON _kind GET "${_hc_manifest}" components ${_i} fetch kind)
            string(JSON _dir GET "${_hc_manifest}" components ${_i} fetch dir)
            set(_pins "")
            if(_kind STREQUAL "git")
                string(JSON _pins GET "${_hc_manifest}" components ${_i} fetch commit)
            elseif(_kind STREQUAL "archive")
                string(JSON _pins GET "${_hc_manifest}" components ${_i} fetch sha256)
            elseif(_kind STREQUAL "files")
                string(JSON _nf LENGTH "${_hc_manifest}" components ${_i} fetch files)
                math(EXPR _lf "${_nf} - 1")
                foreach(_k RANGE ${_lf})
                    string(JSON _s GET "${_hc_manifest}" components ${_i} fetch files ${_k} sha256)
                    list(APPEND _pins "${_s}")
                endforeach()
            endif()
            set(_path "${HALFCUBE_DEPS_DIR}/${_dir}")
            set(_stamp "${_path}/.halfcube-pin")
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
    message(FATAL_ERROR "Component ${id} is not listed in ${HC_MANIFEST}")
endfunction()

hc_dependency(nlohmann-json HC_JSON)
hc_dependency(eigen HC_EIGEN)
hc_dependency(boost HC_BOOST)
hc_dependency(planegcs HC_PLANEGCS)
set(HC_PLANEGCS_SOURCE "${HC_PLANEGCS_VERSION}")
set(HC_PLANEGCS_COMMIT "${HC_PLANEGCS_PIN}")

add_library(hc_json INTERFACE)
target_include_directories(hc_json SYSTEM INTERFACE "${HC_JSON_DIR}/include")
add_library(hc::json ALIAS hc_json)

add_library(hc_eigen INTERFACE)
target_include_directories(hc_eigen SYSTEM INTERFACE "${HC_EIGEN_DIR}")
# Compile error if any LGPL-licensed part of Eigen is used; only the MPL-2.0 parts (plus one Apache-2.0 and one
# BSD-3-Clause header) may be built in.
target_compile_definitions(hc_eigen INTERFACE EIGEN_MPL2_ONLY)
add_library(hc::eigen ALIAS hc_eigen)

add_library(hc_boost INTERFACE)
target_include_directories(hc_boost SYSTEM INTERFACE "${HC_BOOST_DIR}")
add_library(hc::boost ALIAS hc_boost)

if(HALFCUBE_BUILD_TESTS)
    hc_dependency(doctest HC_DOCTEST)
    add_library(hc_doctest INTERFACE)
    target_include_directories(hc_doctest SYSTEM INTERFACE "${HC_DOCTEST_DIR}/include")
    add_library(hc::doctest ALIAS hc_doctest)
endif()

# planegcs: FreeCAD's sketch solver, compiled unchanged from the fetched sources. The shim folder must come first
# for planegcs' own files: it replaces FreeCAD's FCConfig.h (operating-system detection and DLL export macros that planegcs does not use), Base/Console.h
# and the generated QtCore.h. Consumers see every planegcs include folder as SYSTEM.
set(_hc_planegcs_src "${HC_PLANEGCS_DIR}/src/Mod/Sketcher/App/planegcs")
set(_hc_planegcs_shim "${CMAKE_CURRENT_SOURCE_DIR}/third_party_shims/planegcs")
add_library(hc_planegcs STATIC
    "${_hc_planegcs_src}/GCS.cpp"
    "${_hc_planegcs_src}/Constraints.cpp"
    "${_hc_planegcs_src}/Geo.cpp"
    "${_hc_planegcs_src}/SubSystem.cpp"
    "${_hc_planegcs_src}/qp_eq.cpp")
target_include_directories(hc_planegcs BEFORE PRIVATE "${_hc_planegcs_shim}" "${_hc_planegcs_src}" "${HC_PLANEGCS_DIR}/src")
target_include_directories(hc_planegcs SYSTEM INTERFACE "${_hc_planegcs_shim}" "${_hc_planegcs_src}" "${HC_PLANEGCS_DIR}/src")
target_link_libraries(hc_planegcs PUBLIC hc::eigen hc::boost)
# SketcherExport empty: a plain static library instead of __declspec(dllimport) on Windows.
target_compile_definitions(hc_planegcs PUBLIC SketcherExport=)
if(MSVC)
    target_compile_options(hc_planegcs PRIVATE /bigobj /utf-8 /w /EHsc)
else()
    target_compile_options(hc_planegcs PRIVATE -w)
endif()
# System::diagnose starts std::async, which needs the thread library.
find_package(Threads REQUIRED)
target_link_libraries(hc_planegcs PUBLIC Threads::Threads)
add_library(hc::planegcs ALIAS hc_planegcs)
