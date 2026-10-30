import sys
import onnxruntime as ort
so = ort.SessionOptions()
so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
so.optimized_model_filepath = sys.argv[2]
ort.InferenceSession(sys.argv[1], so, providers=["CPUExecutionProvider"])
