#include "capture_gpu.h"
#include <d3dcompiler.h>
#include <cstring>
#include <stdexcept>

using Microsoft::WRL::ComPtr;
namespace triscord {
namespace { void check(HRESULT hr) { if (FAILED(hr)) throw std::runtime_error("GPU preview failed"); } }
CaptureGpuPreview::CaptureGpuPreview(ID3D11Device* device, ID3D11DeviceContext* context) : device_(device), context_(context) {
    const char* shader = R"(
        struct Vertex { float4 position : SV_POSITION; float2 uv : TEXCOORD0; };
        Vertex vertex(uint id : SV_VertexID) {
            Vertex v; v.uv = float2((id << 1) & 2, id & 2);
            v.position = float4(v.uv * float2(2, -2) + float2(-1, 1), 0, 1); return v;
        }
        Texture2D image : register(t0); SamplerState filtering : register(s0);
        float4 pixel(Vertex v) : SV_TARGET { return float4(image.Sample(filtering, v.uv).rgb, 1); }
    )";
    ComPtr<ID3DBlob> vs, ps;
    check(D3DCompile(shader, std::strlen(shader), nullptr, nullptr, nullptr, "vertex", "vs_4_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &vs, nullptr));
    check(D3DCompile(shader, std::strlen(shader), nullptr, nullptr, nullptr, "pixel", "ps_4_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &ps, nullptr));
    check(device_->CreateVertexShader(vs->GetBufferPointer(), vs->GetBufferSize(), nullptr, &vertex_));
    check(device_->CreatePixelShader(ps->GetBufferPointer(), ps->GetBufferSize(), nullptr, &pixel_));
    D3D11_SAMPLER_DESC sampler{}; sampler.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler.MaxLOD = D3D11_FLOAT32_MAX;
    check(device_->CreateSamplerState(&sampler, &sampler_));
    D3D11_RASTERIZER_DESC raster{}; raster.FillMode = D3D11_FILL_SOLID; raster.CullMode = D3D11_CULL_NONE; raster.DepthClipEnable = TRUE;
    check(device_->CreateRasterizerState(&raster, &raster_));
}
QImage CaptureGpuPreview::render(ID3D11Texture2D* texture, QSize content) {
    const QSize preview = previewSize(content);
    if (preview.isEmpty()) throw std::runtime_error("Invalid capture dimensions");
    D3D11_TEXTURE2D_DESC original{}; texture->GetDesc(&original);
    if (original.Width < UINT(content.width()) || original.Height < UINT(content.height()) || original.Format != DXGI_FORMAT_B8G8R8A8_UNORM)
        throw std::runtime_error("Unsupported capture texture");
    if (content_ != content || preview_ != preview) {
        source_.Reset(); target_.Reset(); input_.Reset(); output_.Reset(); staging_.Reset();
        D3D11_TEXTURE2D_DESC desc{}; desc.Width = content.width(); desc.Height = content.height();
        desc.MipLevels = 1; desc.ArraySize = 1; desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        check(device_->CreateTexture2D(&desc, nullptr, &input_));
        check(device_->CreateShaderResourceView(input_.Get(), nullptr, &source_));
        desc.Width = preview.width(); desc.Height = preview.height(); desc.BindFlags = D3D11_BIND_RENDER_TARGET;
        check(device_->CreateTexture2D(&desc, nullptr, &output_));
        check(device_->CreateRenderTargetView(output_.Get(), nullptr, &target_));
        desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        check(device_->CreateTexture2D(&desc, nullptr, &staging_));
        content_ = content; preview_ = preview;
    }
    D3D11_BOX region{0, 0, 0, UINT(content.width()), UINT(content.height()), 1};
    context_->CopySubresourceRegion(input_.Get(), 0, 0, 0, 0, texture, 0, &region);
    ID3D11RenderTargetView* targets[] = {target_.Get()};
    context_->OMSetRenderTargets(1, targets, nullptr);
    D3D11_VIEWPORT viewport{0, 0, float(preview.width()), float(preview.height()), 0, 1};
    context_->RSSetViewports(1, &viewport); context_->RSSetState(raster_.Get());
    // Media Foundation also uses this device. Set every state our full-screen triangle depends on instead
    // of inheriting a blend write mask, input layout or geometry shader left by another D3D user.
    context_->IASetInputLayout(nullptr);
    context_->GSSetShader(nullptr, nullptr, 0);
    context_->HSSetShader(nullptr, nullptr, 0);
    context_->DSSetShader(nullptr, nullptr, 0);
    context_->OMSetBlendState(nullptr, nullptr, 0xffffffff);
    context_->OMSetDepthStencilState(nullptr, 0);
    context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context_->VSSetShader(vertex_.Get(), nullptr, 0); context_->PSSetShader(pixel_.Get(), nullptr, 0);
    ID3D11ShaderResourceView* resources[] = {source_.Get()}; context_->PSSetShaderResources(0, 1, resources);
    ID3D11SamplerState* samplers[] = {sampler_.Get()}; context_->PSSetSamplers(0, 1, samplers);
    context_->Draw(3, 0);
    ID3D11ShaderResourceView* empty[] = {nullptr}; context_->PSSetShaderResources(0, 1, empty);
    context_->OMSetRenderTargets(0, nullptr, nullptr);
    context_->CopyResource(staging_.Get(), output_.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    check(context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    QImage image(preview, QImage::Format_RGB32);
    if (image.isNull()) { context_->Unmap(staging_.Get(), 0); throw std::runtime_error("Preview allocation failed"); }
    for (int row = 0; row < preview.height(); ++row)
        std::memcpy(image.scanLine(row), static_cast<char*>(mapped.pData) + row * mapped.RowPitch, preview.width() * 4);
    context_->Unmap(staging_.Get(), 0);
    return image;
}
}
