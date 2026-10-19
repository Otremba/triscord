#include "camera_segmenter.h"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <algorithm>
#include <cstdio>
using namespace triscord;
int main(int argc, char** argv) {
    QCoreApplication app(argc,argv);
    if (argc != 4) return 2;
    try {
        CameraSegmenter model(QFileInfo(QString::fromLocal8Bit(argv[1])).absoluteFilePath(),QFileInfo(QString::fromLocal8Bit(argv[2])).absoluteFilePath());
        const QString output = QString::fromLocal8Bit(argv[3]);
        if (QFileInfo::exists(output) || !QDir().mkpath(output)) throw std::runtime_error("Use a new output directory");
        bool nullRejected=false, extentRejected=false;
        try { model.segment({}); } catch (const std::invalid_argument&) { nullRejected=true; }
        try { model.segment(QImage(4097,1,QImage::Format_RGB888)); } catch (const std::invalid_argument&) { extentRejected=true; }
        if (!nullRejected || !extentRejected) throw std::runtime_error("Invalid image accepted");
        for (const QSize size : {QSize(256,144),QSize(391,211),QSize(1,1)}) {
        const QString caseOutput=output+QString("/%1x%2").arg(size.width()).arg(size.height());
        if (!QDir().mkpath(caseOutput)) throw std::runtime_error("Cannot create fixture directory");
        QImage image(size,QImage::Format_RGB888);
        for (int y=0;y<image.height();++y) for (int x=0;x<image.width();++x) {
            auto* pixel=image.scanLine(y)+x*3; pixel[0]=x&255; pixel[1]=y&255; pixel[2]=(x+y)&255;
        }
        for (int i=0;i<5;++i) model.segment(image);
        std::vector<double> times; std::span<const float> mask;
        for (int i=0;i<20;++i) { QElapsedTimer clock; clock.start(); mask=model.segment(image); times.push_back(clock.nsecsElapsed()/1000000.0); }
        std::sort(times.begin(),times.end());
        QFile pixels(caseOutput+"/input.rgb"); if (!pixels.open(QIODevice::WriteOnly|QIODevice::NewOnly)) throw std::runtime_error("Cannot write input fixture");
        for (int y=0;y<image.height();++y) if (pixels.write(reinterpret_cast<const char*>(image.constScanLine(y)),image.width()*3)!=image.width()*3) throw std::runtime_error("Cannot write input fixture"); pixels.close();
        QFile values(caseOutput+"/mask.f32"); if (!values.open(QIODevice::WriteOnly|QIODevice::NewOnly) || values.write(reinterpret_cast<const char*>(mask.data()),mask.size_bytes())!=qint64(mask.size_bytes())) throw std::runtime_error("Cannot write mask fixture"); values.close();
        QJsonObject report{{"maskWidth",256},{"maskHeight",144},{"frames",20},{"medianMs",times[times.size()/2]},
            {"p95Ms",times[18]},{"scope","C++ preprocessing and CPU inference; synthetic input; not complete effects or person accuracy"}};
        report["inputWidth"]=size.width(); report["inputHeight"]=size.height(); report["inputStride"]=image.bytesPerLine();
        report["invalidInputRejected"]=nullRejected && extentRejected;
        QFile file(caseOutput+"/report.json"); if (!file.open(QIODevice::WriteOnly|QIODevice::NewOnly)) throw std::runtime_error("Cannot write report");
        file.write(QJsonDocument(report).toJson());
        std::puts(QJsonDocument(report).toJson(QJsonDocument::Compact).constData());
        }
        return 0;
    } catch (const std::exception& error) { std::fprintf(stderr,"%s\n",error.what()); return 1; }
}
