#include "video_gpu.h"
#include "video_codec.h"
#include <stdexcept>
#include <algorithm>

using Microsoft::WRL::ComPtr;
namespace triscord {
namespace { void check(HRESULT hr) { if (FAILED(hr)) throw std::runtime_error("GPU video conversion failed"); } }
VideoGpuConverter::VideoGpuConverter(ID3D11Device* device, ID3D11DeviceContext* context, QSize output, int fps)
    : device_(device), context_(context), output_(output), fps_(fps) {
    if (!device || !context || !VideoConfig{output, fps, 1000000}.valid()) throw std::invalid_argument("Invalid GPU video configuration");
    ComPtr<ID3D11Device> owner; context->GetDevice(&owner);
    if (owner.Get() != device) throw std::invalid_argument("GPU context/device mismatch");
    check(device_.As(&video_)); check(context_.As(&videoContext_));
}
ComPtr<ID3D11Texture2D> VideoGpuConverter::convert(ID3D11Texture2D* bgra, QSize content) {
    if (!bgra || content.width() < 1 || content.height() < 1 || content.width() > 16384 || content.height() > 16384)
        throw std::invalid_argument("Invalid GPU capture input");
    D3D11_TEXTURE2D_DESC source{}; bgra->GetDesc(&source);
    ComPtr<ID3D11Device> owner; bgra->GetDevice(&owner);
    if (owner.Get() != device_.Get() || source.Format != DXGI_FORMAT_B8G8R8A8_UNORM || source.Width < UINT(content.width()) ||
        source.Height < UINT(content.height()) || source.SampleDesc.Count != 1 || source.ArraySize != 1)
        throw std::invalid_argument("Unsupported GPU capture surface");
    if (content_ != content) {
        processor_.Reset(); enumerator_.Reset();
        D3D11_VIDEO_PROCESSOR_CONTENT_DESC desc{};
        desc.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
        desc.InputFrameRate = desc.OutputFrameRate = {UINT(fps_), 1};
        desc.InputWidth = UINT(content.width()); desc.InputHeight = UINT(content.height());
        desc.OutputWidth = UINT(output_.width()); desc.OutputHeight = UINT(output_.height());
        desc.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
        check(video_->CreateVideoProcessorEnumerator(&desc, &enumerator_));
        UINT input = 0, output = 0;
        check(enumerator_->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &input));
        check(enumerator_->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &output));
        if (!(input & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) || !(output & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT))
            throw std::runtime_error("GPU does not support BGRA to NV12");
        check(video_->CreateVideoProcessor(enumerator_.Get(), 0, &processor_));
        videoContext_->VideoProcessorSetStreamFrameFormat(processor_.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        videoContext_->VideoProcessorSetStreamAutoProcessingMode(processor_.Get(), 0, FALSE);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE rgb{}; rgb.RGB_Range = 0; // Full-range RGB.
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE yuv{}; yuv.YCbCr_Matrix = 1; yuv.Nominal_Range = 1; // BT.709, 16-235.
        videoContext_->VideoProcessorSetStreamColorSpace(processor_.Get(), 0, &rgb);
        videoContext_->VideoProcessorSetOutputColorSpace(processor_.Get(), &yuv);
        D3D11_VIDEO_COLOR black{}; black.RGBA.A = 1;
        videoContext_->VideoProcessorSetOutputBackgroundColor(processor_.Get(), FALSE, &black);
        RECT targetRect{0, 0, output_.width(), output_.height()};
        videoContext_->VideoProcessorSetOutputTargetRect(processor_.Get(), TRUE, &targetRect);
        RECT sourceRect{0, 0, content.width(), content.height()};
        const double scale = std::min(double(output_.width()) / content.width(), double(output_.height()) / content.height());
        const int width = std::max(2, int(content.width() * scale) & ~1);
        const int height = std::max(2, int(content.height() * scale) & ~1);
        const int left = ((output_.width() - width) / 2) & ~1, top = ((output_.height() - height) / 2) & ~1;
        RECT dest{left, top, left + width, top + height};
        videoContext_->VideoProcessorSetStreamSourceRect(processor_.Get(), 0, TRUE, &sourceRect);
        videoContext_->VideoProcessorSetStreamDestRect(processor_.Get(), 0, TRUE, &dest);
        content_ = content;
    }
    // Owned GPU copy detaches processing from the WGC surface lease. Fresh
    // input/output resources avoid overwriting frames still in the GPU/codec.
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = UINT(content.width()); desc.Height = UINT(content.height());
    desc.MipLevels = desc.ArraySize = 1; desc.SampleDesc.Count = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    ComPtr<ID3D11Texture2D> input, output;
    check(device_->CreateTexture2D(&desc, nullptr, &input));
    D3D11_BOX region{0, 0, 0, desc.Width, desc.Height, 1};
    context_->CopySubresourceRegion(input.Get(), 0, 0, 0, 0, bgra, 0, &region);
    desc.Width = UINT(output_.width()); desc.Height = UINT(output_.height()); desc.Format = DXGI_FORMAT_NV12;
    check(device_->CreateTexture2D(&desc, nullptr, &output));
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC in{};
    in.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC out{};
    out.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11VideoProcessorInputView> inputView;
    ComPtr<ID3D11VideoProcessorOutputView> outputView;
    check(video_->CreateVideoProcessorInputView(input.Get(), enumerator_.Get(), &in, &inputView));
    check(video_->CreateVideoProcessorOutputView(output.Get(), enumerator_.Get(), &out, &outputView));
    D3D11_VIDEO_PROCESSOR_STREAM stream{}; stream.Enable = TRUE; stream.pInputSurface = inputView.Get();
    check(videoContext_->VideoProcessorBlt(processor_.Get(), outputView.Get(), 0, 1, &stream));
    context_->Flush();
    return output;
}
}
