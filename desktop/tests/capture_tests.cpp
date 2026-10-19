#include "capture_types.h"
#include "capture_gpu.h"
#include <QtTest>
#include <thread>
#include <atomic>

using namespace triscord;
class CaptureTests : public QObject {
    Q_OBJECT
private slots:
    void previewDoesNotInheritAZeroGpuWriteMask() {
        // Isolated software D3D device and generated texture: no desktop capture, app launch or network.
        Microsoft::WRL::ComPtr<ID3D11Device> device;
        Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
        D3D_FEATURE_LEVEL feature;
        QVERIFY(SUCCEEDED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device, &feature, &context)));
        CaptureGpuPreview preview(device.Get(), context.Get());
        D3D11_BLEND_DESC blend{}; // deliberately disallow all color writes, as another device user could
        Microsoft::WRL::ComPtr<ID3D11BlendState> disabledWrites;
        QVERIFY(SUCCEEDED(device->CreateBlendState(&blend, &disabledWrites)));
        for (const QColor color : {QColor(220, 40, 70), QColor(30, 180, 210)}) {
            QImage original(32, 24, QImage::Format_RGB32); original.fill(color);
            D3D11_TEXTURE2D_DESC desc{};
            desc.Width = 32; desc.Height = 24; desc.MipLevels = desc.ArraySize = 1;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
            desc.Usage = D3D11_USAGE_IMMUTABLE; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
            D3D11_SUBRESOURCE_DATA data{original.constBits(), UINT(original.bytesPerLine()), 0};
            Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
            QVERIFY(SUCCEEDED(device->CreateTexture2D(&desc, &data, &texture)));
            context->OMSetBlendState(disabledWrites.Get(), nullptr, 0xffffffff);
            const auto image = preview.render(texture.Get(), original.size());
            QCOMPARE(image.size(), original.size());
            QCOMPARE(image.pixelColor(16, 12), color);
        }
    }
    void previewIsBoundedAndKeepsAspect() {
        QCOMPARE(previewSize({3840, 2160}), QSize(640, 360));
        QCOMPARE(previewSize({1080, 1920}), QSize(202, 360));
        QCOMPARE(previewSize({320, 180}), QSize(320, 180));
        QVERIFY(previewSize({0, 1080}).isEmpty());
        QVERIFY(previewSize({17000, 1080}).isEmpty());
    }
    void slowConsumerGetsOnlyLatestFrame() {
        PreviewMailbox mailbox; mailbox.select(1);
        std::atomic<int> notifications{0};
        std::thread producer([&] {
            for (int n = 0; n < 1000; ++n)
                if (mailbox.publish({{}, {1920, 1080}, n, 1})) ++notifications;
        });
        producer.join();
        QCOMPARE(notifications.load(), 1);
        const auto frame = mailbox.take(); QVERIFY(frame);
        QCOMPARE(frame->time100ns, qint64(999));
        QVERIFY(!mailbox.take());
        QVERIFY(mailbox.publish({{}, {1920, 1080}, 1000, 1}));
    }
    void sourceChangeRejectsOldGeneration() {
        PreviewMailbox mailbox; mailbox.select(1);
        QVERIFY(mailbox.publish({{}, {1920, 1080}, 1, 1}));
        mailbox.select(2);
        QVERIFY(!mailbox.publish({{}, {1920, 1080}, 2, 1}));
        QVERIFY(!mailbox.take());
        QVERIFY(mailbox.publish({{}, {640, 360}, 3, 2}));
        const auto frame = mailbox.take(); QVERIFY(frame);
        QCOMPARE(frame->generation, quint64(2));
    }
    void pendingNotificationCanDeliverNewSource() {
        PreviewMailbox mailbox; mailbox.select(1);
        QVERIFY(mailbox.publish({{}, {1920, 1080}, 1, 1}));
        mailbox.select(2);
        QVERIFY(!mailbox.publish({{}, {640, 360}, 2, 2}));
        const auto frame = mailbox.take(); QVERIFY(frame);
        QCOMPARE(frame->generation, quint64(2));
        QCOMPARE(frame->time100ns, qint64(2));
        QVERIFY(mailbox.publish({{}, {640, 360}, 3, 2}));
    }
};
QTEST_GUILESS_MAIN(CaptureTests)
#include "capture_tests.moc"
