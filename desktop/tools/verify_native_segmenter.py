"""External C++ fixture validation against independent RGB resizing + ORT."""
import json
from pathlib import Path
import sys
import numpy as np
import onnxruntime as ort

def resize(image):
    def axis(old,new):
        coords=np.maximum(np.float32(0),(np.arange(new,dtype=np.float32)+np.float32(.5))*np.float32(old)/np.float32(new)-np.float32(.5))
        lo=np.minimum(coords.astype(np.int64),old-1); hi=np.minimum(lo+1,old-1)
        return lo,hi,(coords-lo).astype(np.float32)
    y0,y1,fy=axis(image.shape[0],144); x0,x1,fx=axis(image.shape[1],256)
    top=image[y0][:,x0]*(1-fx)[None,:,None]+image[y0][:,x1]*fx[None,:,None]
    bottom=image[y1][:,x0]*(1-fx)[None,:,None]+image[y1][:,x1]*fx[None,:,None]
    return ((top*(1-fy)[:,None,None]+bottom*fy[:,None,None])/np.float32(255))[None]

def main(directory,model):
    options=ort.SessionOptions(); options.intra_op_num_threads=1; options.inter_op_num_threads=1
    session=ort.InferenceSession(model,options,providers=['CPUExecutionProvider']); results=[]
    for case in sorted(Path(directory).iterdir()):
        if not case.is_dir(): continue
        report=json.loads((case/'report.json').read_text())
        image=np.fromfile(case/'input.rgb',np.uint8).astype(np.float32).reshape(report['inputHeight'],report['inputWidth'],3)
        expected=session.run(None,{session.get_inputs()[0].name:resize(image)})[0].reshape(-1)
        actual=np.fromfile(case/'mask.f32',dtype='<f4')
        error=float(np.max(np.abs(expected-actual)))
        assert actual.size==256*144 and np.isfinite(actual).all() and error<0.000002,(case,error)
        assert report['invalidInputRejected']
        results.append({'case':case.name,'maxAbsoluteError':error,'maskMaximum':float(actual.max()),'inputStride':report['inputStride']})
    assert len(results)==3
    result={'cases':results,'scope':'C++ inference and pixel-center resize on synthetic inputs; not person accuracy, composition or WAN'}
    (Path(directory)/'comparison.json').write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps(result))

if __name__=='__main__': main(*sys.argv[1:])
