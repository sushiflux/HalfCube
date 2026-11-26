// Kernel self-test: a block 80 x 50 x 20 mm, a vertical through hole of 20 mm at (40, 25) and a 3 mm fillet on
// the hole's top edge. Every operation is checked with BRepCheck_Analyzer and against closed-form volume and face
// count (see shape_check.hpp).
#pragma once

#include "core/errors.hpp"
#include "generated/protocol.hpp"

namespace hc::kernel {

protocol::KernelSelftestResult runSelftest(const CancelCheck& cancelled);

// Closed-form volumes of the three stages in mm^3.
double selftestBlockVolume();
double selftestHoleVolume();
double selftestFilletVolume();

} // namespace hc::kernel
