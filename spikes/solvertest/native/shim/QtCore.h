// Stand-in for the QtCore.h that FreeCAD generates at configure time (src/QtCore.h.cmake) and that
// src/FCGlobal.h includes at its end. planegcs does not use Qt; FCGlobal.h only checks
// HAVE_Q_DISABLE_COPY_MOVE afterwards and falls back to its own macro when it is not defined.
// The shim is intentionally empty.
#ifndef PARTCRAFT_SOLVERTEST_SHIM_QTCORE_H
#define PARTCRAFT_SOLVERTEST_SHIM_QTCORE_H
#endif
