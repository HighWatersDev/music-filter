import hashlib
import sys
import onnx

m = onnx.load(sys.argv[1])
seen, alias, keep = {}, {}, []
for init in m.graph.initializer:
    key = (init.data_type, tuple(init.dims), hashlib.sha1(init.SerializeToString().replace(init.name.encode(), b"")).hexdigest())
    if key in seen:
        alias[init.name] = seen[key]
    else:
        seen[key] = init.name
        keep.append(init)
del m.graph.initializer[:]
m.graph.initializer.extend(keep)
for node in m.graph.node:
    for i, name in enumerate(node.input):
        if name in alias:
            node.input[i] = alias[name]
onnx.save(m, sys.argv[2])
print(f"removed {len(alias)} duplicate initializers")
