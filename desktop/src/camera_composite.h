#pragma once
#include <d3d11.h>
#include <wrl/client.h>
namespace triscord {
// Thread-confined alpha composition. Inputs belong to this device; output is
// fresh and immutable for downstream encoding. No capture or queue is owned.
class CameraGpuComposite final {
public:
    CameraGpuComposite(ID3D11Device* device, ID3D11DeviceContext* context);
    Microsoft::WRL::ComPtr<ID3D11Texture2D> blend(ID3D11Texture2D* foreground, ID3D11Texture2D* background, ID3D11Texture2D* mask, float confidenceThreshold = 0);
    Microsoft::WRL::ComPtr<ID3D11Texture2D> filterMask(ID3D11Texture2D* mask, float sigmaSpace, float sigmaColor);
    Microsoft::WRL::ComPtr<ID3D11Texture2D> smoothMask(ID3D11Texture2D* mask, ID3D11Texture2D* previous, float previousRatio = 0.95f);
    Microsoft::WRL::ComPtr<ID3D11Texture2D> blurPass(ID3D11Texture2D* frame, ID3D11Texture2D* mask, float horizontalPixels, float verticalPixels);
private:
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> view(ID3D11Texture2D* texture, DXGI_FORMAT format);
    Microsoft::WRL::ComPtr<ID3D11Texture2D> draw(ID3D11ShaderResourceView* const* resources, UINT width, UINT height, DXGI_FORMAT format, ID3D11PixelShader* shader);
    Microsoft::WRL::ComPtr<ID3D11Device> device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11VertexShader> vertex_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> pixel_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> bilateral_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> temporal_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> blur_;
    Microsoft::WRL::ComPtr<ID3D11Buffer> passParams_;
    Microsoft::WRL::ComPtr<ID3D11SamplerState> sampler_;
    Microsoft::WRL::ComPtr<ID3D11RasterizerState> raster_;
};
}
