#include "sound_player.h"
#include <QGuiApplication>
#include <QMediaDevices>
#include <QAudioDevice>
#include <QJsonObject>
#include <QSettings>
#include <QTimer>
#include <QMap>
#include <QFile>
#include <QJsonDocument>
#include <QCryptographicHash>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <wrl/client.h>
#include <cstdio>
using Microsoft::WRL::ComPtr;
using namespace triscord;
// This MinGW SDK only forward-declares the Core Audio meter interface.
struct AudioMeter : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetPeakValue(float*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetMeteringChannelCount(UINT*) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetChannelsPeakValues(UINT,float*) = 0;
    virtual HRESULT STDMETHODCALLTYPE QueryHardwareSupport(DWORD*) = 0;
};
__CRT_UUID_DECL(AudioMeter,0xc02216f6,0x8c67,0x4b5b,0x9d,0x00,0xd0,0x08,0xe7,0x3e,0x00,0x64)

// Read only Windows mixer inspection. Meter only our own test or the explicitly supplied Triscord PID.
static double inspect(DWORD pid, bool verbose) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return -1;
    ComPtr<IMMDeviceCollection> devices;
    if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) return -1;
    UINT count=0; devices->GetCount(&count); double peak=0;
    for (UINT i=0;i<count;++i) {
        ComPtr<IMMDevice> device; devices->Item(i,&device); LPWSTR id=nullptr; device->GetId(&id);
        ComPtr<IAudioEndpointVolume> volume;
        if (verbose && SUCCEEDED(device->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(volume.GetAddressOf())))) {
            BOOL mute=FALSE; float level=0; volume->GetMute(&mute); volume->GetMasterVolumeLevelScalar(&level);
            std::printf("endpoint %ls mute=%d volume=%.3f\n",id,int(mute),level);
        }
        ComPtr<IAudioSessionManager2> manager;
        if (SUCCEEDED(device->Activate(__uuidof(IAudioSessionManager2),CLSCTX_ALL,nullptr,reinterpret_cast<void**>(manager.GetAddressOf())))) {
            ComPtr<IAudioSessionEnumerator> sessions; manager->GetSessionEnumerator(&sessions); int n=0;
            if (sessions) sessions->GetCount(&n);
            for (int j=0;j<n;++j) {
                ComPtr<IAudioSessionControl> control; sessions->GetSession(j,&control);
                ComPtr<IAudioSessionControl2> control2; if (!control || FAILED(control.As(&control2))) continue;
                DWORD owner=0; control2->GetProcessId(&owner); if (owner!=pid) continue;
                ComPtr<ISimpleAudioVolume> simple; control.As(&simple); BOOL mute=FALSE; float level=0;
                if (simple) { simple->GetMute(&mute); simple->GetMasterVolume(&level); }
                ComPtr<AudioMeter> meter; float value=0;
                if (SUCCEEDED(control.As(&meter))) meter->GetPeakValue(&value);
                peak=std::max(peak,double(value));
                if (verbose) std::printf("session pid=%lu endpoint=%ls mute=%d volume=%.3f peak=%.6f\n",pid,id,int(mute),level,value);
            }
        }
        CoTaskMemFree(id);
    }
    return peak;
}
int main(int argc,char** argv) {
    QGuiApplication app(argc,argv); app.setOrganizationName("TriscordAudioCheck"); app.setApplicationName("OutputSmoke");
    CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    if (argc==3 && QString::fromLocal8Bit(argv[1])=="--inspect") {
        for (const auto& d:QMediaDevices::audioOutputs()) std::printf("Qt output default=%d name=%s id=%s\n",d.isDefault(),d.description().toUtf8().constData(),d.id().toHex().constData());
        inspect(QString::fromLocal8Bit(argv[2]).toULong(),true); return 0;
    }
    if (argc==2 && QString::fromLocal8Bit(argv[1])=="--decode-all") {
        qputenv("TRISCORD_AUDIO_MODE","injected"); qputenv("TRISCORD_TEST_DECODE_AUDIO","1");
        SoundPlayer decoder; QFile manifest(":/call-sounds/manifest.json"); if(!manifest.open(QIODevice::ReadOnly)) return 2;
        const auto entries=QJsonDocument::fromJson(manifest.readAll()).array(); int index=0;
        QTimer deadline; deadline.setSingleShot(true); QObject::connect(&deadline,&QTimer::timeout,&app,[&]{app.exit(3);});
        std::function<void()> next;
        next=[&]{
            if(index==entries.size()){std::printf("PASS: %d original notification files hash-verified and decoded\n",index);app.exit(0);return;}
            const auto entry=entries[index].toObject(); const auto id=entry.value("id").toString();
            QFile source(":/call-sounds/"+id+".mp3");
            if(!source.open(QIODevice::ReadOnly) || QString::fromLatin1(QCryptographicHash::hash(source.readAll(),QCryptographicHash::Sha256).toHex())!=entry.value("sha256").toString()){app.exit(4);return;}
            decoder.setDeafened(false); decoder.playCue(id); deadline.start(5000);
        };
        QObject::connect(&decoder,&SoundPlayer::failed,&app,[&]{app.exit(5);});
        QObject::connect(&decoder,&SoundPlayer::decoded,&app,[&](const QString& kind,const QString& id,qint64 samples,double peak){
            if(kind!="cue" || samples<=0 || peak<=0 || id!=entries[index].toObject().value("id").toString()){app.exit(6);return;}
            std::printf("PASS: original %s PCM samples=%lld peak=%.6f\n",id.toUtf8().constData(),samples,peak);deadline.stop();++index;
            QTimer::singleShot(0,&app,next);
        });
        QTimer::singleShot(0,&app,next); return app.exec();
    }
    const bool cues = argc == 2 && QString::fromLocal8Bit(argv[1]) == "--cues";
    SoundPlayer player; double peak=0; bool failed=false;
    QString phase; QMap<QString,double> peaks;
    QObject::connect(&player,&SoundPlayer::failed,&app,[&](const QString& text){std::fprintf(stderr,"FAIL: %s\n",text.toUtf8().constData());failed=true;});
    QObject::connect(&player,&SoundPlayer::decoded,&app,[&](const QString& kind,const QString& id,qint64 samples,double value){std::printf("decoded %s %s samples=%lld peak=%.6f\n",kind.toUtf8().constData(),id.toUtf8().constData(),samples,value);});
    QTimer meter; meter.setInterval(20);
    QObject::connect(&meter,&QTimer::timeout,&app,[&]{const auto value=inspect(GetCurrentProcessId(),false); peak=std::max(peak,value); if (!phase.isEmpty()) peaks[phase]=std::max(peaks.value(phase),value);});meter.start();
    if (cues) {
        int delay=300;
        for (const auto& name : {"join","leave","mute","unmute"}) {
            QTimer::singleShot(delay,&app,[&,name]{phase=name; player.playCue(name);}); delay+=(QString(name)=="join" ? 2200 : 800);
        }
    } else QTimer::singleShot(300,&app,[&]{player.play(SoundPlayer::catalog().first().toObject().value("id").toString(),true);});
    QTimer::singleShot(cues ? 6500 : 5500,&app,[&]{
        inspect(GetCurrentProcessId(),true); std::printf("Windows session peak=%.6f\n",peak);
        for (auto it=peaks.begin();it!=peaks.end();++it) { std::printf("cue %s Windows session peak=%.6f\n",it.key().toUtf8().constData(),it.value()); if (it.value()<=0.0001) failed=true; }
        app.exit(!failed && peak>0.0001 ? 0 : 1);
    });
    return app.exec();
}
