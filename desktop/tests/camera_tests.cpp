#include "camera_capture.h"
#include "camera_service.h"
#include "camera_encoder.h"
#include "camera_mask.h"
#include "camera_composite.h"
#include <QAbstractVideoBuffer>
#include <QtTest>
#include <QImage>
#include <thread>
#include <future>
#include <limits>
using namespace triscord;
class Nv12CameraBuffer final : public QAbstractVideoBuffer {
public:
    explicit Nv12CameraBuffer(bool truncated = false) : truncated_(truncated) {}
    MapData map(QVideoFrame::MapMode) override {
        MapData data; data.planeCount = 2;
        for (int plane = 0; plane < 2; ++plane) {
            data.bytesPerLine[plane] = 656;
            data.data[plane] = reinterpret_cast<uchar*>(planes_[plane].data());
            data.dataSize[plane] = truncated_ ? 16 : int(planes_[plane].size());
        }
        return data;
    }
    QVideoFrameFormat format() const override {
        QVideoFrameFormat format({640, 360}, QVideoFrameFormat::Format_NV12);
        format.setColorSpace(QVideoFrameFormat::ColorSpace_BT709);
        format.setColorRange(QVideoFrameFormat::ColorRange_Video); return format;
    }
private:
    QByteArray planes_[2]{QByteArray(656 * 360, char(97)), QByteArray(656 * 180, char(128))};
    bool truncated_;
};
class CameraTests : public QObject {
    Q_OBJECT
private slots:
    void gpuBilateralMaskMatchesIndependentReference() {
        using Microsoft::WRL::ComPtr;
        ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
        QVERIFY(SUCCEEDED(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_WARP,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context)));
        CameraGpuComposite filter(device.Get(),context.Get());
        constexpr int width=8,height=4;
        std::vector<float> values(width*height);
        for (int y=0;y<height;++y) for (int x=0;x<width;++x) values[y*width+x]=float((x*3+y*5)%11)/10;
        D3D11_TEXTURE2D_DESC desc{}; desc.Width=width; desc.Height=height; desc.MipLevels=desc.ArraySize=1; desc.SampleDesc.Count=1;
        desc.Format=DXGI_FORMAT_R32_FLOAT; desc.BindFlags=D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA data{values.data(),width*sizeof(float),0}; ComPtr<ID3D11Texture2D> source;
        QVERIFY(SUCCEEDED(device->CreateTexture2D(&desc,&data,&source)));
        auto sample=[&](float u,float v) {
            const float x=std::clamp(u*width-0.5f,0.0f,float(width-1)),y=std::clamp(v*height-0.5f,0.0f,float(height-1));
            const int x0=int(x),y0=int(y),x1=std::min(x0+1,width-1),y1=std::min(y0+1,height-1);
            const float fx=x-x0,fy=y-y0;
            return (values[y0*width+x0]*(1-fx)+values[y0*width+x1]*fx)*(1-fy)+(values[y1*width+x0]*(1-fx)+values[y1*width+x1]*fx)*fy;
        };
        for (const float radius : {10.0f,3.0f}) {
            auto output=filter.filterMask(source.Get(),radius,0.3f);
            desc.BindFlags=0; desc.Usage=D3D11_USAGE_STAGING; desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
            ComPtr<ID3D11Texture2D> staging; QVERIFY(SUCCEEDED(device->CreateTexture2D(&desc,nullptr,&staging)));
            context->CopyResource(staging.Get(),output.Get()); D3D11_MAPPED_SUBRESOURCE mapped{};
            QVERIFY(SUCCEEDED(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped)));
            float maxError=0;
            for (int y=0;y<height;++y) for (int x=0;x<width;++x) {
                const float u=(x+0.5f)/width,v=(y+0.5f)/height,center=values[y*width+x];
                const float step=std::max(1.0f,std::sqrt(radius)*0.66f),offset=step>1?step/2:0,spatialSigma=radius/height;
                double sum=0,total=0;
                for (float ky=-radius+offset;ky<=radius;ky+=step) for (float kx=-radius+offset;kx<=radius;kx+=step) {
                    const float sx=kx/width,sy=ky/height,value=sample(u+sx,v+sy),difference=value-center;
                    const double weight=std::exp(-0.5*(sx*sx+sy*sy)/(4*spatialSigma*spatialSigma+0.000001))*std::exp(-0.5*difference*difference/(4*0.3*0.3+0.000001));
                    sum+=weight*value; total+=weight;
                }
                const auto* row=reinterpret_cast<const float*>(static_cast<const char*>(mapped.pData)+y*mapped.RowPitch);
                maxError=std::max(maxError,std::abs(row[x]-float(sum/total)));
            }
            context->Unmap(staging.Get(),0); QVERIFY2(maxError<0.0005f,qPrintable(QString::number(maxError)));
        }
        auto first=filter.smoothMask(source.Get(),nullptr);
        const auto earlier=values;
        values.assign(width*height,0.5f); context->UpdateSubresource(source.Get(),0,nullptr,values.data(),width*sizeof(float),0);
        auto smoothed=filter.smoothMask(source.Get(),first.Get());
        ComPtr<ID3D11Texture2D> temporalReadback; QVERIFY(SUCCEEDED(device->CreateTexture2D(&desc,nullptr,&temporalReadback)));
        context->CopyResource(temporalReadback.Get(),smoothed.Get()); D3D11_MAPPED_SUBRESOURCE temporalMapped{};
        QVERIFY(SUCCEEDED(context->Map(temporalReadback.Get(),0,D3D11_MAP_READ,0,&temporalMapped)));
        float temporalError=0;
        for(int y=0;y<height;++y) for(int x=0;x<width;++x) {
            const auto* row=reinterpret_cast<const float*>(static_cast<const char*>(temporalMapped.pData)+y*temporalMapped.RowPitch);
            temporalError=std::max(temporalError,std::abs(row[x]-(0.5f+(earlier[y*width+x]-0.5f)*0.95f)));
        }
        context->Unmap(temporalReadback.Get(),0); QVERIFY(temporalError<0.000002f);
        QVERIFY_EXCEPTION_THROWN(filter.smoothMask(source.Get(),first.Get(),1.01f),std::invalid_argument);
        QVERIFY_EXCEPTION_THROWN(filter.filterMask(source.Get(),0,0.3f),std::invalid_argument);
        QVERIFY_EXCEPTION_THROWN(filter.filterMask(source.Get(),10,std::numeric_limits<float>::quiet_NaN()),std::invalid_argument);
    }
    void gpuCompositionPreservesPixelsAndOwnedOutput() {
        using Microsoft::WRL::ComPtr;
        ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
        QVERIFY(SUCCEEDED(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_WARP,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context)));
        CameraGpuComposite compositor(device.Get(),context.Get());
        auto texture = [&](DXGI_FORMAT format, const void* data, UINT pitch) {
            D3D11_TEXTURE2D_DESC desc{}; desc.Width=8; desc.Height=4; desc.ArraySize=desc.MipLevels=1; desc.SampleDesc.Count=1;
            desc.Format=format; desc.Usage=D3D11_USAGE_DEFAULT; desc.BindFlags=D3D11_BIND_SHADER_RESOURCE;
            D3D11_SUBRESOURCE_DATA source{data,pitch,0}; ComPtr<ID3D11Texture2D> result;
            if (FAILED(device->CreateTexture2D(&desc,&source,&result))) throw std::runtime_error("GPU fixture allocation failed");
            return result;
        };
        const std::vector<quint32> foreground(32,qRgb(160,80,40)),background(32,qRgb(20,40,200));
        std::vector<float> values(32,0.25f);
        auto fg=texture(DXGI_FORMAT_B8G8R8A8_UNORM,foreground.data(),32);
        auto bg=texture(DXGI_FORMAT_B8G8R8A8_UNORM,background.data(),32);
        auto mask=texture(DXGI_FORMAT_R32_FLOAT,values.data(),32);
        auto first=compositor.blend(fg.Get(),bg.Get(),mask.Get());
        values.assign(32,1); context->UpdateSubresource(mask.Get(),0,nullptr,values.data(),32,0);
        auto second=compositor.blend(fg.Get(),bg.Get(),mask.Get()); QVERIFY(first.Get()!=second.Get());
        auto read = [&](ID3D11Texture2D* source,int x=0,int y=0) {
            D3D11_TEXTURE2D_DESC desc{}; source->GetDesc(&desc); desc.BindFlags=0; desc.Usage=D3D11_USAGE_STAGING; desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
            ComPtr<ID3D11Texture2D> staging;
            if (FAILED(device->CreateTexture2D(&desc,nullptr,&staging))) throw std::runtime_error("GPU readback allocation failed");
            context->CopyResource(staging.Get(),source); D3D11_MAPPED_SUBRESOURCE mapped{};
            if (FAILED(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped))) throw std::runtime_error("GPU readback failed");
            const auto* row=reinterpret_cast<const quint32*>(static_cast<const char*>(mapped.pData)+y*mapped.RowPitch);
            const auto color=row[x]; context->Unmap(staging.Get(),0); return color;
        };
        const auto mixed=read(first.Get()); QVERIFY(std::abs(qRed(mixed)-55)<=1); QVERIFY(std::abs(qGreen(mixed)-50)<=1); QVERIFY(std::abs(qBlue(mixed)-160)<=1);
        values.assign(32,0.25f); context->UpdateSubresource(mask.Get(),0,nullptr,values.data(),32,0);
        QCOMPARE(read(compositor.blend(fg.Get(),bg.Get(),mask.Get(),0.5f).Get()),qRgb(20,40,200));
        const auto atThreshold=read(compositor.blend(fg.Get(),bg.Get(),mask.Get(),0.25f).Get());
        QVERIFY(std::abs(qRed(atThreshold)-55)<=1);
        QVERIFY_EXCEPTION_THROWN(compositor.blend(fg.Get(),bg.Get(),mask.Get(),-0.1f),std::invalid_argument);
        QCOMPARE(read(second.Get()),qRgb(160,80,40));
        values.assign(32,0); context->UpdateSubresource(mask.Get(),0,nullptr,values.data(),32,0);
        QCOMPARE(read(compositor.blend(fg.Get(),bg.Get(),mask.Get()).Get()),qRgb(20,40,200));
        QVERIFY_EXCEPTION_THROWN(compositor.blend(fg.Get(),bg.Get(),nullptr),std::invalid_argument);
        QVERIFY_EXCEPTION_THROWN(compositor.blend(fg.Get(),bg.Get(),fg.Get()),std::invalid_argument);
        std::vector<quint32> pulse(32,qRgb(0,0,0));
        for(int y=0;y<4;++y) pulse[y*8+3]=qRgb(255,0,0);
        auto pattern=texture(DXGI_FORMAT_B8G8R8A8_UNORM,pulse.data(),32);
        auto blurred=compositor.blurPass(pattern.Get(),mask.Get(),1,0);
        // The leftmost pixel receives only distant taps from the red impulse.
        const auto left=read(blurred.Get()); QVERIFY(qRed(left)>0 && qRed(left)<30);
        auto linear=[&](float position) {
            position=std::clamp(position,0.0f,7.0f); const int low=int(position),high=std::min(low+1,7); const float fraction=position-low;
            return qRed(pulse[low])*(1-fraction)+qRed(pulse[high])*fraction;
        };
        const float offsets[]{1.411764705882353f,3.2941176470588234f,5.176470588235294f};
        const float weights[]{0.2969069646728344f,0.09447039785044732f,0.010381362401148057f};
        for(int x=0;x<8;++x) {
            float expected=linear(x)*0.1964825501511404f;
            for(int tap=0;tap<3;++tap) expected+=(linear(x+offsets[tap])+linear(x-offsets[tap]))*weights[tap];
            const auto actual=read(blurred.Get(),x);
            QVERIFY(std::abs(qRed(actual)-expected)<=2); QCOMPARE(qGreen(actual),0); QCOMPARE(qBlue(actual),0);
        }
        values.assign(32,1); context->UpdateSubresource(mask.Get(),0,nullptr,values.data(),32,0);
        QCOMPARE(read(compositor.blurPass(pattern.Get(),mask.Get(),1,0).Get()),qRgb(0,0,0));
        QCOMPARE(read(compositor.blurPass(fg.Get(),mask.Get(),1,0).Get()),qRgb(160,80,40));
        QVERIFY_EXCEPTION_THROWN(compositor.blurPass(fg.Get(),mask.Get(),std::numeric_limits<float>::quiet_NaN(),0),std::invalid_argument);
    }
    void temporalMaskPreservesConfidentChangesAndResets() {
        CameraMaskSmoother smoother;
        const std::array<float,2> zero{0,0}, uncertain{0.5f,0.5f}, one{1,1};
        QCOMPARE(smoother.update(zero,2,1)[0], 0.0f);
        const auto filtered = smoother.update(uncertain,2,1);
        QVERIFY(std::abs(filtered[0] - 0.025f) < 0.00001f);
        // MediaPipe's uncertainty polynomial has a small endpoint residual.
        QVERIFY(std::abs(smoother.update(one,2,1)[0] - 0.99996f) < 0.000001f);
        QVERIFY(std::abs(smoother.update(zero,2,1)[0] - 0.0000415f) < 0.000001f);
        smoother.reset(); QCOMPARE(smoother.update(uncertain,2,1)[0],0.5f);
        QCOMPARE(smoother.update(zero,1,2)[0],0.0f);
    }
    void invalidMaskDoesNotPoisonTemporalState() {
        CameraMaskSmoother smoother;
        const std::array<float,2> start{0.2f,0.2f}, current{0.5f,0.5f};
        smoother.update(start,2,1);
        const std::array<float,2> bad{0.8f,std::numeric_limits<float>::quiet_NaN()};
        QVERIFY_EXCEPTION_THROWN(smoother.update(bad,2,1),std::invalid_argument);
        QVERIFY_EXCEPTION_THROWN(smoother.update(current,257,1),std::invalid_argument);
        QVERIFY_EXCEPTION_THROWN(smoother.update(current,2,1,1.1f),std::invalid_argument);
        QVERIFY(std::abs(smoother.update(current,2,1)[0] - 0.215f) < 0.00001f);
    }
    void slowConsumerRetainsOnlyLatestNativeFrame() {
        CameraFrames mailbox; mailbox.select(1);
        QImage image(64, 48, QImage::Format_RGB32); image.fill(Qt::white);
        int notifications = 0;
        std::thread producer([&] {
            for (int i = 0; i < 1000; ++i) {
                QVideoFrame frame(image); frame.setStartTime(i); if (mailbox.publish(1, frame)) ++notifications;
            }
        }); producer.join();
        QCOMPARE(notifications, 1);
        const auto frame = mailbox.take(); QVERIFY(frame); QCOMPARE(frame->startTime(), qint64(999));
        QCOMPARE(frame->size(), QSize(64, 48)); QVERIFY(!mailbox.take());
    }
    void stopAndRestartRejectOldCameraFrames() {
        CameraFrames mailbox; mailbox.select(1);
        QImage image(64, 48, QImage::Format_RGB32); image.fill(Qt::white);
        QVideoFrame frame(image); mailbox.publish(1, frame);
        mailbox.select(2); mailbox.publish(1, frame); QVERIFY(!mailbox.take());
        mailbox.publish(2, QVideoFrame{}); QVERIFY(!mailbox.take());
        mailbox.publish(2, frame); QVERIFY(mailbox.take());
    }
    void pendingNotificationDeliversOnlyNewestCamera() {
        CameraFrames mailbox; mailbox.select(1);
        QImage image(64, 48, QImage::Format_RGB32); image.fill(Qt::white);
        QVideoFrame first(image); first.setStartTime(1);
        QVERIFY(mailbox.publish(1, first));
        mailbox.select(2); QVERIFY(!mailbox.publish(1, first));
        QVideoFrame second(image); second.setStartTime(2);
        QVERIFY(!mailbox.publish(2, second));
        const auto frame = mailbox.take(); QVERIFY(frame); QCOMPARE(frame->startTime(), qint64(2));
        QVERIFY(!mailbox.take()); QVERIFY(mailbox.publish(2, second));
    }
    void cameraServiceStartsLazilyCancelsAndDeliversOnUiThread() {
        CameraService service;
        auto* workerThread = service.findChild<QThread*>("triscordCameraMedia"); QVERIFY(workerThread);
        QVERIFY(!workerThread->isRunning());
        QSignalSpy errors(&service, &CameraService::message), active(&service, &CameraService::activeChanged);
        QSignalSpy devices(&service, &CameraService::devicesReady);
        bool onUiThread = false;
        connect(&service, &CameraService::devicesReady, &service, [&] {
            onUiThread = QThread::currentThread() == service.thread();
        });
        service.start("triscord-missing-camera-id-for-test"); service.stop();
        service.requestDevices(); service.requestDevices();
        QTRY_COMPARE(devices.size(), 1); QVERIFY(onUiThread); QVERIFY(workerThread->isRunning());
        QCOMPARE(errors.size(), 0); QCOMPARE(active.size(), 0); QVERIFY(!service.isActive());
        service.start("triscord-missing-camera-id-for-test"); QTRY_COMPARE(errors.size(), 1);
        QCOMPARE(active.size(), 0); QVERIFY(!service.isActive()); service.stop();
    }
    void closingServiceDiscardsQueuedDeviceResults() {
        int deliveries = 0;
        auto* service = new CameraService;
        connect(service, &CameraService::devicesReady, this, [&] { ++deliveries; });
        service->requestDevices(); delete service;
        QTest::qWait(60); QCOMPARE(deliveries, 0);
    }
    void idleAndMissingDeviceNeverActivateCamera() {
        CameraCapture capture; QSignalSpy frames(&capture, &CameraCapture::frameReady);
        QSignalSpy active(&capture, &CameraCapture::activeChanged), errors(&capture, &CameraCapture::message);
        QTest::qWait(60); QCOMPARE(frames.size(), 0); QCOMPARE(active.size(), 0);
        capture.start("triscord-missing-camera-id-for-test"); QCOMPARE(errors.size(), 1);
        capture.stop(); QTest::qWait(60); QCOMPARE(frames.size(), 0); QCOMPARE(active.size(), 0);
    }
    void cameraOrientationIsAppliedButSelfieMirrorIsNotEncoded() {
        QImage source(320, 180, QImage::Format_RGB32); source.fill(Qt::red);
        for (int y = 0; y < source.height(); ++y) for (int x = 160; x < source.width(); ++x) source.setPixelColor(x, y, Qt::green);
        QVideoFrame frame(source); frame.setMirrored(true);
        auto image = cameraImage(frame); QCOMPARE(image.size(), source.size()); QCOMPARE(image.pixelColor(80, 90), QColor(Qt::red));
        frame.setRotation(QtVideo::Rotation::Clockwise90);
        image = cameraImage(frame); QCOMPARE(image.size(), QSize(180, 320));
        QCOMPARE(image.pixelColor(90, 80), QColor(Qt::red)); QCOMPARE(image.pixelColor(90, 240), QColor(Qt::green));
        QVERIFY_EXCEPTION_THROWN(cameraImage(QVideoFrame{}), std::invalid_argument);
        QVideoFrameFormat hdrFormat({640,360}, QVideoFrameFormat::Format_NV12);
        hdrFormat.setColorTransfer(QVideoFrameFormat::ColorTransfer_ST2084);
        QVERIFY_EXCEPTION_THROWN(cameraImage(QVideoFrame(hdrFormat)), std::invalid_argument);
    }
    void nativeCameraPlanesEncodeAndDecodeWithPaddedStride() {
        // Match production ownership: Media Foundation codecs require an MTA
        // media thread, while QApplication's Windows GUI thread is STA.
        auto result = std::async(std::launch::async, [] {
        auto require = [](bool condition, const char* message) { if (!condition) throw std::runtime_error(message); };
        VideoConfig config{{640,360}, 30, 1000000};
        CameraEncoder encoder(config, EncoderPreference::SoftwareOnly); VideoDecoder decoder(config);
        QVideoFrame frame(std::make_unique<Nv12CameraBuffer>());
        int sent = 0, received = 0; qint64 lastTime = -1; bool requested = false, observed = false;
        QElapsedTimer elapsed; elapsed.start();
        while (received < 30 && elapsed.elapsed() < 5000) {
            if (sent < 30 && encoder.submit(frame, qint64(sent) * 333333)) ++sent;
            if (sent >= 10 && !requested) { require(encoder.requestKeyframe(), "Camera keyframe request rejected"); requested = true; }
            for (const auto& encoded : encoder.poll()) {
                if (encoded.keyframe && encoded.time100ns >= 10 * 333333) observed = true;
                require(decoder.submit(encoded), "Camera decoder rejected input");
            }
            for (const auto& decoded : decoder.poll()) {
                require(decoded.size == config.size, "Camera decoded dimensions changed");
                require(decoded.time100ns > lastTime && decoded.time100ns % 333333 == 0, "Camera timestamps changed"); lastTime = decoded.time100ns;
                const int center = 180 * 640 + 320;
                require(std::abs(int(uint8_t(decoded.nv12[center])) - 97) <= 8, "Camera pixels differ from native input"); ++received;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        require(sent == 30 && received == 30 && observed && !frame.isMapped(), "Camera roundtrip or recovery incomplete");
        bool repeated = false, negative = false;
        try { encoder.submit(frame, lastTime); } catch (const std::invalid_argument&) { repeated = true; }
        try { encoder.submit(frame, -1); } catch (const std::invalid_argument&) { negative = true; }
        require(repeated && negative, "Camera accepted invalid timestamps");
        });
        try { result.get(); } catch (const std::exception& error) { QFAIL(error.what()); }
    }
    void shortCameraPlaneIsRejectedBeforeReadingIt() {
        auto result = std::async(std::launch::async, [] {
        CameraEncoder encoder({{640,360},30,1000000}, EncoderPreference::SoftwareOnly);
        QVideoFrame frame(std::make_unique<Nv12CameraBuffer>(true));
        bool rejected = false;
        try { encoder.submit(frame, 0); } catch (const std::runtime_error& error) {
            rejected = QString::fromUtf8(error.what()).contains("NV12 camera");
        }
        return rejected && !frame.isMapped();
        });
        try { QVERIFY(result.get()); } catch (const std::exception& error) { QFAIL(error.what()); }
    }
    void cameraSurfaceEncodesAndDecodesThroughDirectX11() {
        using Microsoft::WRL::ComPtr;
        auto result = std::async(std::launch::async, [] {
            auto require = [](bool condition, const char* message) { if (!condition) throw std::runtime_error(message); };
            VideoConfig config{{640,360}, 30, 1000000};
            CameraEncoder encoder(config, EncoderPreference::SoftwareOnly);
            VideoDecoder decoder(config);
            require(encoder.ready(), "Camera encoder not ready");
            auto* device = encoder.gpuDevice();
            auto* context = encoder.gpuContext();
            require(device != nullptr && context != nullptr, "Missing D3D11 device/context from camera encoder");

            D3D11_TEXTURE2D_DESC desc{};
            desc.Width = 640; desc.Height = 360;
            desc.MipLevels = desc.ArraySize = 1; desc.SampleDesc.Count = 1;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;

            std::vector<uint32_t> pixels(640 * 360, 0xFF787878);
            D3D11_SUBRESOURCE_DATA initData{};
            initData.pSysMem = pixels.data();
            initData.SysMemPitch = 640 * sizeof(uint32_t);

            ComPtr<ID3D11Texture2D> surface;
            HRESULT hr = device->CreateTexture2D(&desc, &initData, &surface);
            require(SUCCEEDED(hr) && surface, "Failed to create camera D3D11 test surface");

            int sent = 0, received = 0; qint64 lastTime = -1;
            QElapsedTimer elapsed; elapsed.start();
            while (received < 20 && elapsed.elapsed() < 5000) {
                if (sent < 20 && encoder.submitSurface(surface.Get(), config.size, qint64(sent) * 333333)) {
                    ++sent;
                }
                for (const auto& encoded : encoder.poll()) {
                    require(decoder.submit(encoded), "Camera decoder rejected encoded surface frame");
                }
                for (const auto& decoded : decoder.poll()) {
                    require(decoded.size == config.size, "Decoded surface size mismatch");
                    require(decoded.time100ns > lastTime, "Surface decoded timestamp not monotonic");
                    lastTime = decoded.time100ns;
                    const int center = 180 * 640 + 320;
                    require(std::abs(int(uint8_t(decoded.nv12[center])) - 120) <= 20, "Surface decoded pixel values deviated");
                    ++received;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            require(sent == 20 && received == 20, "Surface encode/decode roundtrip incomplete");

            bool nullRejected = false, repeatedRejected = false, negativeRejected = false;
            try { encoder.submitSurface(nullptr, config.size, lastTime + 333333); } catch (const std::invalid_argument&) { nullRejected = true; }
            try { encoder.submitSurface(surface.Get(), config.size, lastTime); } catch (const std::invalid_argument&) { repeatedRejected = true; }
            try { encoder.submitSurface(surface.Get(), config.size, -1); } catch (const std::invalid_argument&) { negativeRejected = true; }
            require(nullRejected && repeatedRejected && negativeRejected, "Surface validation failed to reject invalid parameters");
        });
        try { result.get(); } catch (const std::exception& error) { QFAIL(error.what()); }
    }
};
QTEST_MAIN(CameraTests)
#include "camera_tests.moc"
