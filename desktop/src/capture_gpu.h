#pragma once
#include "capture_types.h"
#include <d3d11.h>
#include <wrl/client.h>

namespace triscord {
class CaptureGpuPreview final {
public:
    CaptureGpuPreview(ID3D11Device* device, ID3D11DeviceContext* context);
    QImage render(ID3D11Texture2D* texture, QSize content);
private:
    Microsoft::WRL::ComPtr<ID3D11Device> device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11VertexShader> vertex_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> pixel_;
    Microsoft::WRL::ComPtr<ID3D11SamplerState> sampler_;
    Microsoft::WRL::ComPtr<ID3D11RasterizerState> raster_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> input_, output_, staging_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> source_;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> target_;
    QSize content_, preview_;
};
}
