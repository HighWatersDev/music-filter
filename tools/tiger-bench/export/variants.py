import sys
import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxconverter_common import float16

src, stem = sys.argv[1], sys.argv[2]
quantize_dynamic(src, f"{stem}_int8.onnx", weight_type=QuantType.QInt8)
quantize_dynamic(src, f"{stem}_int8mm.onnx", weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "LSTM"])
m = onnx.load(src)
m16 = float16.convert_float_to_float16(m, keep_io_types=True)
onnx.save(m16, f"{stem}_fp16.onnx")
