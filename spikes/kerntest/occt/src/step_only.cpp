// Minimal STEP-only program: reads a STEP file and writes it back. Used to measure what OCCT costs when it is
// linked only for STEP import and export (the hybrid case where another kernel does the modelling).
//   kerntest_occt_steponly <in.step> <out.step>

#include <BRepCheck_Analyzer.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_Writer.hxx>
#include <TopExp.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <NCollection_IndexedMap.hxx>

#include <cstdio>

int main(int argc, char** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: kerntest_occt_steponly <in.step> <out.step>\n");
        return 2;
    }
    STEPControl_Reader reader;
    if (reader.ReadFile(argv[1]) != IFSelect_RetDone) {
        std::fprintf(stderr, "cannot read %s\n", argv[1]);
        return 1;
    }
    reader.TransferRoots();
    const TopoDS_Shape shape = reader.OneShape();
    NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    const bool valid = BRepCheck_Analyzer(shape).IsValid();
    STEPControl_Writer writer;
    if (writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone || writer.Write(argv[2]) != IFSelect_RetDone) {
        std::fprintf(stderr, "cannot write %s\n", argv[2]);
        return 1;
    }
    std::printf("{\"faces\": %d, \"valid\": %s}\n", faces.Extent(), valid ? "true" : "false");
    return 0;
}
