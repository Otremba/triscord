"""Export the pinned public MediaPipe landscape model; never executes Discord.

Development dependencies: numpy, tflite, flatbuffers, onnx. Output is not
considered inference-equivalent until its operators/reference pipeline pass.
"""
import hashlib
import json
from pathlib import Path
import struct
import sys
import numpy as np
import onnx
from onnx import helper as h, numpy_helper as nh
import tflite

SOURCE_SHA256 = 'a77d03f4659b9f6b6c1f5106947bf40e99d7655094b6527f214ea7d451106edd'

def export(source, destination):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise ValueError('Unrecognized model; review graph/schema before exporting')
    model = tflite.Model.GetRootAsModel(raw, 0)
    graph = model.Subgraphs(0)
    tensors = [graph.Tensors(i) for i in range(graph.TensorsLength())]
    shapes = [t.ShapeAsNumpy().tolist() for t in tensors]
    arrays, nodes = {}, []
    types = {tflite.TensorType.FLOAT32:np.float32, tflite.TensorType.FLOAT16:np.float16,
             tflite.TensorType.INT32:np.int32}
    for i, tensor in enumerate(tensors):
        buffer = model.Buffers(tensor.Buffer())
        if buffer.DataLength():
            arrays[f't{i}'] = np.frombuffer(bytes(buffer.DataAsNumpy()), dtype=types[tensor.Type()]).reshape(shapes[i]).copy()
    def options(op, kind):
        table = op.BuiltinOptions(); value = kind(); value.Init(table.Bytes, table.Pos); return value
    def add(kind, inputs, output, **attrs):
        nodes.append(h.make_node(kind, inputs, [output], **attrs))
    def activation(value):
        if value.FusedActivationFunction() != tflite.ActivationFunctionType.NONE:
            raise ValueError('Unreviewed fused activation')
    for index in range(graph.OperatorsLength()):
        op = graph.Operators(index); code = model.OperatorCodes(op.OpcodeIndex())
        kind = max(code.BuiltinCode(), code.DeprecatedBuiltinCode())
        ids = op.InputsAsNumpy().tolist(); outputs = op.OutputsAsNumpy().tolist()
        if len(outputs) != 1: raise ValueError('Unreviewed multi-output operator')
        inputs = [f't{i}' for i in ids]; output = f't{outputs[0]}'; prefix = f'op{index}'
        if kind == tflite.BuiltinOperator.DEQUANTIZE:
            # This exact graph uses float16 constant weights, not integer quantization.
            value = arrays[inputs[0]]
            if value.dtype != np.float16: raise ValueError('Unreviewed quantization')
            arrays[output] = value.astype(np.float32)
        elif kind in (tflite.BuiltinOperator.CONV_2D, tflite.BuiltinOperator.DEPTHWISE_CONV_2D):
            depthwise = kind == tflite.BuiltinOperator.DEPTHWISE_CONV_2D
            value = options(op, tflite.DepthwiseConv2DOptions if depthwise else tflite.Conv2DOptions); activation(value)
            weight = arrays[inputs[1]]
            arrays[prefix+'w'] = weight.transpose((3,0,1,2) if depthwise else (0,3,1,2)).copy()
            add('Transpose', [inputs[0]], prefix+'in', perm=[0,3,1,2])
            add('Conv', [prefix+'in', prefix+'w', inputs[2]], prefix+'out',
                strides=[value.StrideH(),value.StrideW()], dilations=[value.DilationHFactor(),value.DilationWFactor()],
                group=shapes[ids[0]][3] if depthwise else 1,
                auto_pad='SAME_UPPER' if value.Padding() == tflite.Padding.SAME else 'VALID')
            add('Transpose', [prefix+'out'], output, perm=[0,2,3,1])
        elif kind == tflite.BuiltinOperator.CUSTOM:
            if code.CustomCode() != b'Convolution2DTransposeBias' or bytes(op.CustomOptionsAsNumpy()) != struct.pack('<iii',1,2,2):
                raise ValueError('Unreviewed custom operator/options')
            # MediaPipe transpose_conv_bias.cc uses OHWI weights and bias;
            # this pinned graph is 2x2 / stride 2, with no resulting padding.
            weight = arrays[inputs[1]]
            if weight.shape[1:3] != (2,2) or shapes[outputs[0]][1:3] != [v*2 for v in shapes[ids[0]][1:3]]:
                raise ValueError('Unreviewed transpose convolution extent')
            arrays[prefix+'w'] = weight.transpose(3,0,1,2).copy()
            add('Transpose',[inputs[0]],prefix+'in',perm=[0,3,1,2])
            add('ConvTranspose',[prefix+'in',prefix+'w',inputs[2]],prefix+'out',strides=[2,2],pads=[0,0,0,0])
            add('Transpose',[prefix+'out'],output,perm=[0,2,3,1])
        elif kind == tflite.BuiltinOperator.MEAN:
            value = options(op,tflite.ReducerOptions)
            add('ReduceMean',[inputs[0]],output,axes=arrays[inputs[1]].astype(np.int64).tolist(),keepdims=int(value.KeepDims()))
        elif kind == tflite.BuiltinOperator.RESIZE_BILINEAR:
            value = options(op,tflite.ResizeBilinearOptions)
            target = arrays[inputs[1]].tolist()
            arrays[prefix+'size'] = np.array([shapes[ids[0]][0],*target,shapes[ids[0]][3]],dtype=np.int64)
            mode = 'align_corners' if value.AlignCorners() else 'half_pixel' if value.HalfPixelCenters() else 'asymmetric'
            add('Resize',[inputs[0],'','',prefix+'size'],output,mode='linear',coordinate_transformation_mode=mode)
        else:
            names = {tflite.BuiltinOperator.HARD_SWISH:'HardSwish',tflite.BuiltinOperator.RELU:'Relu',
                     tflite.BuiltinOperator.LOGISTIC:'Sigmoid',tflite.BuiltinOperator.MUL:'Mul',tflite.BuiltinOperator.ADD:'Add'}
            if kind not in names: raise ValueError(f'Unreviewed operator {kind}')
            if kind in (tflite.BuiltinOperator.MUL,tflite.BuiltinOperator.ADD):
                activation(options(op,tflite.MulOptions if kind == tflite.BuiltinOperator.MUL else tflite.AddOptions))
            add(names[kind],inputs,output)
    used = {name for node in nodes for name in node.input}
    inputs = [h.make_tensor_value_info(f't{i}',onnx.TensorProto.FLOAT,shapes[i]) for i in graph.InputsAsNumpy()]
    outputs = [h.make_tensor_value_info(f't{i}',onnx.TensorProto.FLOAT,shapes[i]) for i in graph.OutputsAsNumpy()]
    result = h.make_model(h.make_graph(nodes,'mediapipe-selfie-landscape',inputs,outputs,
                initializer=[nh.from_array(value,name) for name,value in arrays.items() if name in used]),
                opset_imports=[h.make_opsetid('',17)],producer_name='triscord-model-export')
    result.ir_version = 9
    onnx.checker.check_model(result,full_check=True)
    destination = Path(destination)
    if destination.exists(): raise ValueError('Output already exists')
    onnx.save(result,str(destination))
    report = {'sourceSha256':SOURCE_SHA256,'outputSha256':hashlib.sha256(destination.read_bytes()).hexdigest(),
              'bytes':destination.stat().st_size,'nodes':len(nodes),
              'inputs':[shapes[i] for i in graph.InputsAsNumpy()], 'outputs':[shapes[i] for i in graph.OutputsAsNumpy()],
              'validated':'ONNX schema and static shape inference only; inference equivalence pending'}
    destination.with_suffix('.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report))

if __name__ == '__main__':
    export(*sys.argv[1:])
