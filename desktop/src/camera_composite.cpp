#include "camera_composite.h"
#include <d3dcompiler.h>
#include <cstring>
#include <cmath>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
namespace triscord {
namespace {
void check(HRESULT result) { if (FAILED(result)) throw std::runtime_error("Camera GPU composition failed"); }
}
CameraGpuComposite::CameraGpuComposite(ID3D11Device* device, ID3D11DeviceContext* context) : device_(device), context_(context) {
    if (!device || !context) throw std::invalid_argument("Missing camera GPU device/context");
    ComPtr<ID3D11Device> owner; context->GetDevice(&owner);
    if (owner.Get()!=device) throw std::invalid_argument("Camera GPU device/context mismatch");
    const char* shader=R"(
        struct Vertex { float4 position : SV_POSITION; float2 uv : TEXCOORD0; };
        Vertex vertex(uint id : SV_VertexID) {
            Vertex v; v.uv=float2((id<<1)&2,id&2);
            v.position=float4(v.uv*float2(2,-2)+float2(-1,1),0,1); return v;
        }
        Texture2D<float4> foreground : register(t0);
        Texture2D<float4> background : register(t1);
        Texture2D<float> mask : register(t2);
        Texture2D<float> previous : register(t3);
        SamplerState filtering : register(s0);
        cbuffer PassParams : register(b0) { float2 texel; float parameter0; float parameter1; };
        float4 pixel(Vertex v) : SV_TARGET {
            float alpha=saturate(mask.Sample(filtering,v.uv));
            if(alpha<parameter0) alpha=0;
            return float4(lerp(background.Sample(filtering,v.uv).rgb,foreground.Sample(filtering,v.uv).rgb,alpha),1);
        }
        // Scalar-mask form of MediaPipe's subsampled GPU bilateral kernel.
        float gaussian(float x,float sigma) { return exp(x*x*(-0.5/(sigma*sigma*4+0.000001))); }
        float sampleMask(float2 uv) {
            int2 size=int2(round(1.0/texel));
            float2 position=clamp(uv*size-0.5,float2(0,0),float2(size-1));
            int2 low=int2(position),high=min(low+1,size-1); float2 fraction=position-low;
            float top=lerp(mask.Load(int3(low.x,low.y,0)),mask.Load(int3(high.x,low.y,0)),fraction.x);
            float bottom=lerp(mask.Load(int3(low.x,high.y,0)),mask.Load(int3(high.x,high.y,0)),fraction.x);
            return lerp(top,bottom,fraction.y);
        }
        float bilateral(Vertex v) : SV_TARGET {
            float sigmaSpace=parameter0,sigmaColor=parameter1;
            float step=max(1.0,sqrt(sigmaSpace)*0.66);
            float offset=step>1.0?step*0.5:0;
            float center=sampleMask(v.uv), sum=0, total=0;
            float spatialSigma=max(texel.x,texel.y)*sigmaSpace;
            for(float y=-sigmaSpace+offset;y<=sigmaSpace;y+=step) {
                for(float x=-sigmaSpace+offset;x<=sigmaSpace;x+=step) {
                    float2 shift=float2(x,y)*texel;
                    float value=sampleMask(v.uv+shift);
                    float weight=gaussian(length(shift),spatialSigma)*gaussian(abs(value-center),sigmaColor);
                    sum+=weight*value; total+=weight;
                }
            }
            return saturate(sum/max(total,0.0000001));
        }
        float temporal(Vertex v) : SV_TARGET {
            int2 position=int2(v.position.xy);
            float current=saturate(mask.Load(int3(position,0)));
            if(parameter1==0) return current;
            float old=saturate(previous.Load(int3(position,0)));
            float delta=current-0.5, square=delta*delta;
            float certainty=square*(5.68842+square*(-0.748699+square*(-57.8051+square*(291.309-square*624.717))));
            return current+(old-current)*((1-saturate(certainty))*parameter0);
        }
        float3 blurSample(float2 uv,float3 center,float2 offset,float weight) {
            return lerp(foreground.Sample(filtering,uv+offset).rgb,center,mask.Sample(filtering,uv+offset))*weight;
        }
        float4 blur(Vertex v) : SV_TARGET {
            float3 center=foreground.Sample(filtering,v.uv).rgb;
            float2 direction=float2(parameter0,parameter1);
            float3 result=center*0.1964825501511404;
            float2 offset=direction*1.411764705882353;
            result+=blurSample(v.uv,center,offset,0.2969069646728344)+blurSample(v.uv,center,-offset,0.2969069646728344);
            offset=direction*3.2941176470588234;
            result+=blurSample(v.uv,center,offset,0.09447039785044732)+blurSample(v.uv,center,-offset,0.09447039785044732);
            offset=direction*5.176470588235294;
            result+=blurSample(v.uv,center,offset,0.010381362401148057)+blurSample(v.uv,center,-offset,0.010381362401148057);
            return float4(result,1);
        }
    )";
    ComPtr<ID3DBlob> vs,ps;
    check(D3DCompile(shader,std::strlen(shader),nullptr,nullptr,nullptr,"vertex","vs_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&vs,nullptr));
    check(D3DCompile(shader,std::strlen(shader),nullptr,nullptr,nullptr,"pixel","ps_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&ps,nullptr));
    check(device->CreateVertexShader(vs->GetBufferPointer(),vs->GetBufferSize(),nullptr,&vertex_));
    check(device->CreatePixelShader(ps->GetBufferPointer(),ps->GetBufferSize(),nullptr,&pixel_));
    ComPtr<ID3DBlob> filter;
    check(D3DCompile(shader,std::strlen(shader),nullptr,nullptr,nullptr,"bilateral","ps_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&filter,nullptr));
    check(device->CreatePixelShader(filter->GetBufferPointer(),filter->GetBufferSize(),nullptr,&bilateral_));
    ComPtr<ID3DBlob> temporal;
    check(D3DCompile(shader,std::strlen(shader),nullptr,nullptr,nullptr,"temporal","ps_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&temporal,nullptr));
    check(device->CreatePixelShader(temporal->GetBufferPointer(),temporal->GetBufferSize(),nullptr,&temporal_));
    ComPtr<ID3DBlob> blur;
    check(D3DCompile(shader,std::strlen(shader),nullptr,nullptr,nullptr,"blur","ps_4_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&blur,nullptr));
    check(device->CreatePixelShader(blur->GetBufferPointer(),blur->GetBufferSize(),nullptr,&blur_));
    D3D11_BUFFER_DESC params{}; params.ByteWidth=16; params.Usage=D3D11_USAGE_DEFAULT; params.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
    check(device->CreateBuffer(&params,nullptr,&passParams_));
    D3D11_SAMPLER_DESC sampler{}; sampler.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler.AddressU=sampler.AddressV=sampler.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP; sampler.MaxLOD=D3D11_FLOAT32_MAX;
    check(device->CreateSamplerState(&sampler,&sampler_));
    D3D11_RASTERIZER_DESC raster{}; raster.FillMode=D3D11_FILL_SOLID; raster.CullMode=D3D11_CULL_NONE; raster.DepthClipEnable=TRUE;
    check(device->CreateRasterizerState(&raster,&raster_));
}
ComPtr<ID3D11ShaderResourceView> CameraGpuComposite::view(ID3D11Texture2D* texture, DXGI_FORMAT format) {
    if (!texture) throw std::invalid_argument("Missing camera composition surface");
    D3D11_TEXTURE2D_DESC source{}; texture->GetDesc(&source);
    ComPtr<ID3D11Device> owner; texture->GetDevice(&owner);
    if (owner.Get()!=device_.Get() || !source.Width || !source.Height || source.Width>4096 || source.Height>2160 ||
        source.Format!=format || source.MipLevels!=1 || source.ArraySize!=1 || source.SampleDesc.Count!=1 ||
        !(source.BindFlags&D3D11_BIND_SHADER_RESOURCE)) throw std::invalid_argument("Unsupported camera composition surface");
    ComPtr<ID3D11ShaderResourceView> result; check(device_->CreateShaderResourceView(texture,nullptr,&result)); return result;
}
ComPtr<ID3D11Texture2D> CameraGpuComposite::blend(ID3D11Texture2D* foreground, ID3D11Texture2D* background, ID3D11Texture2D* mask,float confidenceThreshold) {
    if (!std::isfinite(confidenceThreshold) || confidenceThreshold<0 || confidenceThreshold>1)
        throw std::invalid_argument("Invalid camera replacement threshold");
    ID3D11Texture2D* inputs[]{foreground,background,mask};
    ComPtr<ID3D11ShaderResourceView> views[3]; D3D11_TEXTURE2D_DESC desc{};
    for (int i=0;i<3;++i) {
        views[i]=view(inputs[i],i==2?DXGI_FORMAT_R32_FLOAT:DXGI_FORMAT_B8G8R8A8_UNORM);
        D3D11_TEXTURE2D_DESC source{}; inputs[i]->GetDesc(&source);
        if (i==0) { desc.Width=source.Width; desc.Height=source.Height; }
    }
    ID3D11ShaderResourceView* resources[]{views[0].Get(),views[1].Get(),views[2].Get(),nullptr};
    const float params[]{1.0f/desc.Width,1.0f/desc.Height,confidenceThreshold,0};
    context_->UpdateSubresource(passParams_.Get(),0,nullptr,params,0,0);
    return draw(resources,desc.Width,desc.Height,DXGI_FORMAT_B8G8R8A8_UNORM,pixel_.Get());
}
ComPtr<ID3D11Texture2D> CameraGpuComposite::filterMask(ID3D11Texture2D* mask,float sigmaSpace,float sigmaColor) {
    if (!std::isfinite(sigmaSpace) || sigmaSpace<=0 || sigmaSpace>32 || !std::isfinite(sigmaColor) || sigmaColor<=0 || sigmaColor>1)
        throw std::invalid_argument("Invalid camera bilateral parameters");
    auto source=view(mask,DXGI_FORMAT_R32_FLOAT); D3D11_TEXTURE2D_DESC desc{}; mask->GetDesc(&desc);
    const float params[]{1.0f/desc.Width,1.0f/desc.Height,sigmaSpace,sigmaColor};
    context_->UpdateSubresource(passParams_.Get(),0,nullptr,params,0,0);
    ID3D11ShaderResourceView* resources[]{nullptr,nullptr,source.Get(),nullptr};
    return draw(resources,desc.Width,desc.Height,DXGI_FORMAT_R32_FLOAT,bilateral_.Get());
}
ComPtr<ID3D11Texture2D> CameraGpuComposite::smoothMask(ID3D11Texture2D* mask,ID3D11Texture2D* previous,float previousRatio) {
    if (!std::isfinite(previousRatio) || previousRatio<0 || previousRatio>1) throw std::invalid_argument("Invalid camera smoothing ratio");
    auto source=view(mask,DXGI_FORMAT_R32_FLOAT); ComPtr<ID3D11ShaderResourceView> old;
    D3D11_TEXTURE2D_DESC desc{}; mask->GetDesc(&desc);
    if (previous) {
        old=view(previous,DXGI_FORMAT_R32_FLOAT); D3D11_TEXTURE2D_DESC previousDesc{}; previous->GetDesc(&previousDesc);
        if (previousDesc.Width!=desc.Width || previousDesc.Height!=desc.Height) throw std::invalid_argument("Camera temporal mask size mismatch");
    }
    const float params[]{1.0f/desc.Width,1.0f/desc.Height,previousRatio,previous?1.0f:0.0f};
    context_->UpdateSubresource(passParams_.Get(),0,nullptr,params,0,0);
    ID3D11ShaderResourceView* resources[]{nullptr,nullptr,source.Get(),old.Get()};
    return draw(resources,desc.Width,desc.Height,DXGI_FORMAT_R32_FLOAT,temporal_.Get());
}
ComPtr<ID3D11Texture2D> CameraGpuComposite::blurPass(ID3D11Texture2D* frame,ID3D11Texture2D* mask,float horizontalPixels,float verticalPixels) {
    if (!std::isfinite(horizontalPixels) || !std::isfinite(verticalPixels) || std::abs(horizontalPixels)>32 || std::abs(verticalPixels)>32)
        throw std::invalid_argument("Invalid camera blur direction");
    auto image=view(frame,DXGI_FORMAT_B8G8R8A8_UNORM),segmentation=view(mask,DXGI_FORMAT_R32_FLOAT);
    D3D11_TEXTURE2D_DESC desc{}; frame->GetDesc(&desc);
    const float params[]{1.0f/desc.Width,1.0f/desc.Height,horizontalPixels/desc.Width,verticalPixels/desc.Height};
    context_->UpdateSubresource(passParams_.Get(),0,nullptr,params,0,0);
    ID3D11ShaderResourceView* resources[]{image.Get(),nullptr,segmentation.Get(),nullptr};
    return draw(resources,desc.Width,desc.Height,DXGI_FORMAT_B8G8R8A8_UNORM,blur_.Get());
}
ComPtr<ID3D11Texture2D> CameraGpuComposite::draw(ID3D11ShaderResourceView* const* resources,UINT width,UINT height,DXGI_FORMAT format,ID3D11PixelShader* shader) {
    D3D11_TEXTURE2D_DESC desc{}; desc.Width=width; desc.Height=height;
    desc.MipLevels=desc.ArraySize=1; desc.SampleDesc.Count=1; desc.Format=format;
    desc.Usage=D3D11_USAGE_DEFAULT; desc.BindFlags=D3D11_BIND_RENDER_TARGET|D3D11_BIND_SHADER_RESOURCE;
    ComPtr<ID3D11Texture2D> output; ComPtr<ID3D11RenderTargetView> target;
    check(device_->CreateTexture2D(&desc,nullptr,&output)); check(device_->CreateRenderTargetView(output.Get(),nullptr,&target));
    ID3D11RenderTargetView* targets[]{target.Get()}; context_->OMSetRenderTargets(1,targets,nullptr);
    D3D11_VIEWPORT viewport{0,0,float(desc.Width),float(desc.Height),0,1};
    context_->RSSetViewports(1,&viewport); context_->RSSetState(raster_.Get());
    context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context_->IASetInputLayout(nullptr); context_->OMSetBlendState(nullptr,nullptr,0xffffffff);
    context_->VSSetShader(vertex_.Get(),nullptr,0); context_->PSSetShader(shader,nullptr,0);
    ID3D11Buffer* params[]{passParams_.Get()}; context_->PSSetConstantBuffers(0,1,params);
    context_->PSSetShaderResources(0,4,resources); ID3D11SamplerState* samplers[]{sampler_.Get()}; context_->PSSetSamplers(0,1,samplers);
    context_->Draw(3,0);
    ID3D11ShaderResourceView* empty[]{nullptr,nullptr,nullptr,nullptr}; context_->PSSetShaderResources(0,4,empty); context_->OMSetRenderTargets(0,nullptr,nullptr);
    return output;
}
}
