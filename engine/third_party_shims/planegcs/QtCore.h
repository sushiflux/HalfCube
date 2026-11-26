// Stand-in for the QtCore.h that FreeCAD generates at configure time and that src/FCGlobal.h includes at its end.
// planegcs does not use Qt; FCGlobal.h only checks HAVE_Q_DISABLE_COPY_MOVE afterwards and falls back to its own
// macro when it is not defined. Intentionally empty.
#ifndef HALFCUBE_PLANEGCS_SHIM_QTCORE_H
#define HALFCUBE_PLANEGCS_SHIM_QTCORE_H
#endif
