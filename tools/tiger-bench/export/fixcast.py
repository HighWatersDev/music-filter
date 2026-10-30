import sys
import onnx
from onnx import TensorProto

m = onnx.load(sys.argv[1])
vi = {v.name: v.type.tensor_type.elem_type for v in m.graph.value_info}
fixed = 0
for n in m.graph.node:
    if n.op_type == "Cast" and vi.get(n.output[0]) == TensorProto.FLOAT16:
        for a in n.attribute:
            if a.name == "to" and a.i == TensorProto.FLOAT:
                a.i = TensorProto.FLOAT16
                fixed += 1
onnx.save(m, sys.argv[2])
print("fixed casts", fixed)
