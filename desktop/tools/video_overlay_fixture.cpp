#include "video_overlays.h"
#include "bundled_fonts.h"
#include <QGuiApplication>
#include <QWindow>
#include <QTimer>
#include <QEnterEvent>
#include <QMouseEvent>
#include <QFontInfo>
#include <QFontMetricsF>
#include <QDir>
#include <cstdio>
#include <cmath>
using namespace triscord;
int main(int argc,char** argv) {
    QGuiApplication app(argc,argv); loadBundledFonts();
    if (argc!=2) return 2;
    QDir().mkpath(QString::fromLocal8Bit(argv[1]));
    QWindow host; host.resize(452,263); host.show();
    VideoOverlays overlays(&host); const QString id="scr:fixture";
    QImage frame(432,243,QImage::Format_RGB32); frame.fill(QColor("#181b22"));
    overlays.setLabel(id,"camargo"); overlays.setLive(id,true,30,720);
    overlays.setSurface(id,QRect(10,10,432,243),1); overlays.setFrame(id,frame);
    int menu=0,focus=0; QObject::connect(&overlays,&VideoOverlays::contextMenuRequested,[&]{++menu;});
    QObject::connect(&overlays,&VideoOverlays::clicked,[&]{++focus;});
    QTimer::singleShot(150,&app,[&]{
        bool passed=true;
        auto check=[&](const char* name,bool ok){std::printf("%s: %s\n",ok?"PASS":"FAIL",name);passed &= ok;};
        auto* child=host.findChild<QWindow*>(); if(!child){app.exit(2);return;}
        QEnterEvent enter(QPointF(100,100),QPointF(100,100),QPointF(100,100)); QCoreApplication::sendEvent(child,&enter);
        const auto snapshot=overlays.snapshots().value(id).second;
        check("full 432x243 stream surface",snapshot.size()==QSize(432,243));
        QFont font; font.setFamilies({"gg sans","Noto Sans","Segoe UI"}); font.setPixelSize(12); font.setWeight(QFont::Bold); font.setLetterSpacing(QFont::AbsoluteSpacing,.24);
        const QFontInfo info(font); std::printf("native font family=%s size=%d weight=%d\n",info.family().toUtf8().constData(),info.pixelSize(),int(info.weight()));
        check("native gg sans, not fallback",info.family().startsWith("gg sans",Qt::CaseInsensitive));
        check("Discord compact badge 12px/700",info.pixelSize()==12 && info.weight()==QFont::Bold);
        const int liveWidth=int(std::ceil(QFontMetricsF(font).horizontalAdvance("AO VIVO")))+12;
        const int qualityWidth=int(std::ceil(QFontMetricsF(font).horizontalAdvance("720P 30FPS")))+12;
        const int split=432-8-liveWidth,left=split-qualityWidth;
        check("joined quality/live badges without gap",snapshot.pixelColor(split-1,12)==QColor("#4e5058") && snapshot.pixelColor(split+1,12)==QColor("#d22d39"));
        check("16px pill has rounded outer corner",snapshot.pixelColor(left,8)==QColor("#181b22") && snapshot.pixelColor(left,16)!=QColor("#181b22"));
        int icon=0;for(int y=207;y<223;++y)for(int x=20;x<36;++x)if(snapshot.pixelColor(x,y).lightness()>180)++icon;
        check("screen glyph in bottom-left name pill",icon>10);
        QMouseEvent more(QEvent::MouseButtonRelease,QPointF(404,215),QPointF(414,225),Qt::LeftButton,Qt::NoButton,Qt::NoModifier);QCoreApplication::sendEvent(child,&more);
        check("ellipsis opens participant menu without focusing",menu==1 && focus==0);
        QMouseEvent click(QEvent::MouseButtonRelease,QPointF(100,100),QPointF(110,110),Qt::LeftButton,Qt::NoButton,Qt::NoModifier);QCoreApplication::sendEvent(child,&click);
        check("stream body still opens focused view",focus==1);
        check("quality text keeps real uppercase grid variant",overlays.badgeText(id,true)=="720P 30FPS | AO VIVO");
        snapshot.save(QDir(QString::fromLocal8Bit(argv[1])).filePath("stream-grid.png"));
        app.exit(passed?0:1);
    });
    return app.exec();
}
