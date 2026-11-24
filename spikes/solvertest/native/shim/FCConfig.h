// Stand-in for FreeCAD's src/FCConfig.h, which planegcs includes in GCS.cpp. FreeCAD's file only
// detects the operating system (it stops with #error on platforms it does not know, for example
// Emscripten) and defines integer typedefs and DLL export macros; planegcs uses none of these
// definitions (no FC_OS_*, PATHSEP or DBG_* in planegcs/). The shim therefore only provides the
// FCGlobal.h include that the real file ends with, so that the include graph stays the same.
#ifndef PARTCRAFT_SOLVERTEST_SHIM_FCCONFIG_H
#define PARTCRAFT_SOLVERTEST_SHIM_FCCONFIG_H

#include <FCGlobal.h>

#endif
