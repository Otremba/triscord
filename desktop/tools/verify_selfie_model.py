"""External model test: independent NHWC NumPy evaluator vs ONNX Runtime.

Not the TensorFlow Lite runtime, Discord execution or real-person accuracy test.
Only the pinned landscape model/operator set is supported.
"""
import json
from pathlib import Path
import time
import numpy as np
import onnxruntime as ort
import onnx
import tflite
from export_selfie_model import SOURCE_SHA256
import hashlib

def reference(raw, image, all_values=False, upstream=None):
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256: raise ValueError('Unexpected model')
    model = tflite.Model.GetRootAsModel(raw,0); graph = model.Subgraphs(0)
    tensors = [graph.Tensors(i) for i in range(graph.TensorsLength())]
    shapes = [t.ShapeAsNumpy().tolist() for t in tensors]; values = {}
    types = {tflite.TensorType.FLOAT32:np.float32,tflite.TensorType.FLOAT16:np.float16,tflite.TensorType.INT32:np.int32}
    for i,tensor in enumerate(tensors):
        buffer = model.Buffers(tensor.Buffer())
        if buffer.DataLength(): values[i] = np.frombuffer(bytes(buffer.DataAsNumpy()),types[tensor.Type()]).reshape(shapes[i])
    values[int(graph.Inputs(0))] = image
    def options(op,cls):
        value=cls(); table=op.BuiltinOptions(); value.Init(table.Bytes,table.Pos); return value
    for index in range(graph.OperatorsLength()):
        op=graph.Operators(index); code=model.OperatorCodes(op.OpcodeIndex()); kind=max(code.BuiltinCode(),code.DeprecatedBuiltinCode())
        ids=op.InputsAsNumpy().tolist(); destination=int(op.Outputs(0))
        args=[upstream.get(i,values[i]) if upstream is not None else values[i] for i in ids]; x=args[0]
        if kind == tflite.BuiltinOperator.DEQUANTIZE: y=x.astype(np.float32)
        elif kind in (tflite.BuiltinOperator.CONV_2D,tflite.BuiltinOperator.DEPTHWISE_CONV_2D):
            dw=kind == tflite.BuiltinOperator.DEPTHWISE_CONV_2D
            opt=options(op,tflite.DepthwiseConv2DOptions if dw else tflite.Conv2DOptions)
            weights,bias=args[1:]; kh,kw=weights.shape[1:3]; sh,sw=opt.StrideH(),opt.StrideW(); dh,dw_stride=opt.DilationHFactor(),opt.DilationWFactor()
            oh,ow=shapes[destination][1:3]; eh,ew=(kh-1)*dh+1,(kw-1)*dw_stride+1
            if opt.Padding() == tflite.Padding.SAME:
                ph=max(0,(oh-1)*sh+eh-x.shape[1]); pw=max(0,(ow-1)*sw+ew-x.shape[2])
                x=np.pad(x,((0,0),(ph//2,ph-ph//2),(pw//2,pw-pw//2),(0,0)))
            windows=np.lib.stride_tricks.sliding_window_view(x,(eh,ew),axis=(1,2)).transpose(0,1,2,4,5,3)
            windows=windows[:,:oh*sh:sh,:ow*sw:sw,::dh,::dw_stride,:]
            if dw:
                if opt.DepthMultiplier()!=1: raise ValueError('Unexpected depth multiplier')
                y=np.einsum('nhwklc,klc->nhwc',windows,weights[0],optimize=True)+bias
            else: y=np.einsum('nhwklc,oklc->nhwo',windows,weights,optimize=True)+bias
        elif kind == tflite.BuiltinOperator.CUSTOM:
            if code.CustomCode()!=b'Convolution2DTransposeBias': raise ValueError('Unexpected custom op')
            # Independent scatter formulation of the public MediaPipe kernel.
            weights,bias=args[1:]; y=np.zeros(shapes[destination],np.float32)+bias
            for ky in range(2):
                for kx in range(2):
                    y[:,ky::2,kx::2,:]+=np.einsum('nhwc,oc->nhwo',x,weights[:,ky,kx,:],optimize=True)
        elif kind == tflite.BuiltinOperator.HARD_SWISH: y=x*np.clip(x+np.float32(3),0,6)/np.float32(6)
        elif kind == tflite.BuiltinOperator.RELU: y=np.maximum(x,0)
        elif kind == tflite.BuiltinOperator.LOGISTIC:
            with np.errstate(over='ignore'): y=1/(1+np.exp(-x))
        elif kind == tflite.BuiltinOperator.MUL: y=x*args[1]
        elif kind == tflite.BuiltinOperator.ADD: y=x+args[1]
        elif kind == tflite.BuiltinOperator.MEAN:
            y=x.mean(axis=tuple(args[1].tolist()),keepdims=options(op,tflite.ReducerOptions).KeepDims())
        elif kind == tflite.BuiltinOperator.RESIZE_BILINEAR:
            opt=options(op,tflite.ResizeBilinearOptions); oh,ow=args[1].tolist()
            def coords(old,new):
                if opt.AlignCorners(): c=np.arange(new,dtype=np.float32)*np.float32((old-1)/(new-1) if new>1 else 0)
                elif opt.HalfPixelCenters(): c=(np.arange(new,dtype=np.float32)+np.float32(.5))*np.float32(old/new)-np.float32(.5)
                else: c=np.arange(new,dtype=np.float32)*np.float32(old/new)
                c=np.maximum(c,0); lo=np.floor(c).astype(np.int64); hi=np.minimum(lo+1,old-1)
                return lo,hi,(c-lo).astype(np.float32)
            y0,y1,fy=coords(x.shape[1],oh); x0,x1,fx=coords(x.shape[2],ow)
            left=x[:,y0][:,:,x0]*(1-fy)[None,:,None,None]+x[:,y1][:,:,x0]*fy[None,:,None,None]
            right=x[:,y0][:,:,x1]*(1-fy)[None,:,None,None]+x[:,y1][:,:,x1]*fy[None,:,None,None]
            y=left*(1-fx)[None,None,:,None]+right*fx[None,None,:,None]
        else: raise ValueError(f'Unexpected operator {kind}')
        if list(y.shape)!=shapes[destination]: raise ValueError(f'Unexpected shape at op {index}')
        values[destination]=y.astype(np.float32)
    return values if all_values else values[int(graph.Outputs(0))]

def main():
    root=Path('.toolchain/camera-effects'); raw=(root/'selfie_segmentation_landscape.tflite').read_bytes()
    options=ort.SessionOptions(); options.intra_op_num_threads=1; options.inter_op_num_threads=1
    session=ort.InferenceSession(str(root/'selfie-landscape.onnx'),options,providers=['CPUExecutionProvider'])
    audit_model=onnx.load(str(root/'selfie-landscape.onnx'))
    original=tflite.Model.GetRootAsModel(raw,0).Subgraphs(0)
    audit_names=sorted({name for node in audit_model.graph.node for name in node.output if name.startswith('t') and name[1:].isdigit()})
    del audit_model.graph.output[:]
    for name in audit_names:
        audit_model.graph.output.append(onnx.helper.make_tensor_value_info(name,onnx.TensorProto.FLOAT,original.Tensors(int(name[1:])).ShapeAsNumpy().tolist()))
    audit=ort.InferenceSession(audit_model.SerializeToString(),options,providers=['CPUExecutionProvider'])
    name=session.get_inputs()[0].name; rng=np.random.default_rng(41)
    cases={'zero':np.zeros((1,144,256,3),np.float32),
           'ramp':np.linspace(0,1,144*256*3,dtype=np.float32).reshape(1,144,256,3),
           'noise':rng.random((1,144,256,3),dtype=np.float32)}; results=[]
    for label,image in cases.items():
        expected_values=reference(raw,image,all_values=True)
        expected=expected_values[int(original.Outputs(0))]; actual=session.run(None,{name:image})[0]
        intermediate_error=0.0
        audit_values=audit.run(None,{name:image})
        # Check each operator with identical upstream values so roundoff from a
        # long independently evaluated graph does not obscure its local contract.
        upstream={int(key[1:]):value for key,value in zip(audit_names,audit_values)}
        graph_intermediate_error=max(float(np.max(np.abs(expected_values[key]-value))) for key,value in upstream.items())
        local_expected=reference(raw,image,all_values=True,upstream=upstream)
        for tensor_name,value in zip(audit_names,audit_values):
            reference_value=local_expected[int(tensor_name[1:])]
            if not np.allclose(reference_value,value,atol=0.0005,rtol=0.0002):
                where=np.unravel_index(np.argmax(np.abs(reference_value-value)),value.shape)
                raise AssertionError(f'{label}: intermediate mismatch {tensor_name}; max={float(np.max(np.abs(reference_value-value)))}; reference={reference_value[where]}; actual={value[where]}')
            intermediate_error=max(intermediate_error,float(np.max(np.abs(reference_value-value))))
        error=float(np.max(np.abs(expected-actual)))
        if not np.isfinite(actual).all() or error>0.0002: raise AssertionError(f'{label}: mask error {error}')
        for _ in range(5): session.run(None,{name:image})
        elapsed=[]
        for _ in range(20):
            start=time.perf_counter(); session.run(None,{name:image}); elapsed.append((time.perf_counter()-start)*1000)
        results.append({'case':label,'maxAbsoluteError':error,'intermediateTensorsChecked':len(audit_names),
                        'maxIsolatedOperatorError':intermediate_error,'maxIndependentGraphIntermediateError':graph_intermediate_error,
                        'medianMs':float(np.median(elapsed)),'p95Ms':float(np.percentile(elapsed,95))})
    report={'runtime':ort.__version__,'threads':1,'cases':results,
            'scope':'Full output for three synthetic inputs plus isolated operators with identical runtime upstream values; not TFLite runtime, person accuracy or complete effects timing'}
    Path('desktop/out/camera-model-reference.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report))

if __name__=='__main__': main()
