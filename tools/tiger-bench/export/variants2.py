import sys
import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxconverter_common import float16

src, stem = sys.argv[1], sys.argv[2]
m = onnx.load(src)
sep_nodes = [n.name for n in m.graph.node if "/separator/" in n.name and n.op_type in ("Conv", "MatMul")]
quantize_dynamic(src, f"{stem}_int8sep.onnx", weight_type=QuantType.QInt8,
                 op_types_to_quantize=["Conv", "MatMul"], nodes_to_quantize=sep_nodes)
quantize_dynamic(src, f"{stem}_int8sepmm.onnx", weight_type=QuantType.QInt8,
                 op_types_to_quantize=["MatMul"], nodes_to_quantize=sep_nodes)
quantize_dynamic(src, f"{stem}_uint8sep.onnx", weight_type=QuantType.QUInt8,
                 op_types_to_quantize=["Conv", "MatMul"], nodes_to_quantize=sep_nodes,
                 extra_options={"ActivationSymmetric": False})
del m.graph.value_info[:]
block = ["LSTM", "TopK", "CumSum", "Atan", "ScatterElements", "GatherElements", "Resize", "InstanceNormalization",
         "Sin", "Cos", "Log", "ReduceL2"]
m16 = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=block)
onnx.save(m16, f"{stem}_fp16.onnx")
