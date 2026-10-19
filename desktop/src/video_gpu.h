#pragma once
#include <QSize>
#include <d3d11.h>
#include <wrl/client.h>

namespace triscord {
// SDR only, thread confined. Outputs are fresh/immutable until the encoder
// releases them; no unsafe reuse of a texture still owned by Media Foundation.
class VideoGpuConverter final {
public:
    VideoGpuConverter(ID3D11Device* device, ID3D11DeviceContext* context, QSize output, int fps);
    Microsoft::WRL::ComPtr<ID3D11Texture2D> convert(ID3D11Texture2D* bgra, QSize content);
private:
    Microsoft::WRL::ComPtr<ID3D11Device> device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11VideoDevice> video_;
    Microsoft::WRL::ComPtr<ID3D11VideoContext> videoContext_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessor> processor_;
    QSize output_, content_;
    int fps_;
};
}
