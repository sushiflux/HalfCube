// Stand-in for FreeCAD's src/FCConfig.h, which planegcs includes in GCS.cpp. FreeCAD's file detects the operating
// system (and stops with #error on platforms it does not know) and defines integer typedefs and
// DLL export macros; planegcs uses none of these definitions. This header only keeps the FCGlobal.h include that
// the original ends with, so the include graph stays the same.
#ifndef HALFCUBE_PLANEGCS_SHIM_FCCONFIG_H
#define HALFCUBE_PLANEGCS_SHIM_FCCONFIG_H

#include <FCGlobal.h>

#endif
